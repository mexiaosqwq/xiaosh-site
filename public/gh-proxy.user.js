// ==UserScript==
// @name         GitHub 下载与图片代理
// @namespace    https://xiaosh.xyz/
// @version      6.1.0
// @description  自动代理 GitHub 下载链接和图片；支持 Blob、srcset、picture、懒加载、Shadow DOM、SPA 与并发控制
// @author       xiaosh
// @match        *://github.com/*
// @match        *://gist.github.com/*
// @match        *://*.githubusercontent.com/*
// @match        *://codeload.github.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @connect      github-proxy.xiaosh.xyz
// ==/UserScript==

(() => {
  'use strict';

  // ============================================================
  // 配置
  // ============================================================

  const CONFIG = Object.freeze({
    PROXY: 'https://github-proxy.xiaosh.xyz/?url=',
    CLIENT_CONCURRENCY: 12,
    REQUEST_TIMEOUT_MS: 30_000,
    MAX_ATTEMPTS: 3,
    RETRY_DELAYS_MS: [600, 1_400],
    BLOB_CACHE_MAX_ENTRIES: 64,
    BLOB_CACHE_MAX_BYTES: 64 * 1024 * 1024,
    BLOB_CACHE_TTL_MS: 10 * 60 * 1_000,
    IMAGE_ROOT_MARGIN: '300px',
    DEBUG: false
  });

  const PROXY_HOST = new URL(CONFIG.PROXY).hostname;

  // ============================================================
  // 日志
  // ============================================================

  function debug(...args) {
    if (CONFIG.DEBUG) console.debug('[GitHub Proxy]', ...args);
  }
  function warn(...args) {
    if (CONFIG.DEBUG) console.warn('[GitHub Proxy]', ...args);
  }

  // ============================================================
  // URL 判定
  // ============================================================

  function isGitHubCDN(hostname) {
    return /(^|\.)githubusercontent\.com$/i.test(hostname) || /^codeload\.github\.com$/i.test(hostname);
  }

  function isGitHubPageHost(hostname) {
    return hostname === 'github.com' || hostname === 'gist.github.com';
  }

  function hasRawFlag(url) {
    if (!url.searchParams.has('raw')) return false;
    const v = url.searchParams.get('raw');
    return v === '' || v === '1' || /^true$/i.test(v);
  }

  const IMAGE_EXTENSION = /\.(?:apng|avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i;

  function isDownloadPath(url) {
    const p = url.pathname;
    if (url.hostname === 'github.com') {
      return (
        /^\/[^/]+\/[^/]+\/releases\/(?:latest\/)?download(?:\/|$)/i.test(p) ||
        /^\/[^/]+\/[^/]+\/(?:archive|zipball|tarball|raw)(?:\/|$)/i.test(p) ||
        /^\/[^/]+\/[^/]+\/(?:files|assets)(?:\/|$)/i.test(p) ||
        /^\/user-attachments\/(?:files|assets)(?:\/|$)/i.test(p) ||
        /^\/(?:files|assets)(?:\/|$)/i.test(p)
      );
    }
    if (url.hostname === 'gist.github.com') {
      return /^\/[^/]+\/[^/]+\/(?:archive|raw)(?:\/|$)/i.test(p);
    }
    return false;
  }

  function shouldProxy(url) {
    if (!(url instanceof URL)) return false;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (url.hostname === PROXY_HOST) return false;
    if (isGitHubCDN(url.hostname)) return true;
    if (!isGitHubPageHost(url.hostname)) return false;
    if (url.pathname.includes('/tree/')) return false;
    if (url.pathname.includes('/blob/')) return hasRawFlag(url);
    if (hasRawFlag(url)) return true;
    return isDownloadPath(url) || IMAGE_EXTENSION.test(url.pathname);
  }

  function proxyURL(url) {
    return CONFIG.PROXY + encodeURIComponent(url instanceof URL ? url.href : String(url));
  }

  function normalizeResourceURL(url) {
    const u = new URL(url);
    u.hash = '';
    return u.href;
  }

  // ============================================================
  // 直接访问 CDN 跳转
  // ============================================================

  if (isGitHubCDN(location.hostname)) {
    try {
      const u = new URL(location.href);
      if (shouldProxy(u)) location.replace(proxyURL(u));
    } catch (e) { warn('CDN 跳转失败：', e); }
    return;
  }

  // ============================================================
  // 并发队列
  // ============================================================

  class RequestQueue {
    constructor(max) { this.max = max; this.active = 0; this.queue = []; }
    add(fn) {
      return new Promise((resolve, reject) => {
        this.queue.push({ fn, resolve, reject });
        this.next();
      });
    }
    next() {
      while (this.active < this.max && this.queue.length) {
        const { fn, resolve, reject } = this.queue.shift();
        this.active++;
        Promise.resolve().then(fn).then(resolve, reject).finally(() => { this.active--; this.next(); });
      }
    }
  }

  const requestQueue = new RequestQueue(CONFIG.CLIENT_CONCURRENCY);

  // ============================================================
  // Blob LRU/TTL 缓存
  // ============================================================

  const blobCache = new Map();
  const inflightRequests = new Map();
  let blobCacheBytes = 0;

  function removeBlobCacheEntry(key) {
    const entry = blobCache.get(key);
    if (!entry) return;
    blobCache.delete(key);
    blobCacheBytes -= entry.size;
    if (blobCacheBytes < 0) blobCacheBytes = 0;
  }

  function getCachedBlob(key) {
    const entry = blobCache.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) { removeBlobCacheEntry(key); return null; }
    blobCache.delete(key);
    blobCache.set(key, entry);
    return entry.blob;
  }

  function setCachedBlob(key, blob) {
    if (!blob || typeof blob.size !== 'number' || blob.size <= 0) return;
    if (blob.size > CONFIG.BLOB_CACHE_MAX_BYTES) return;
    removeBlobCacheEntry(key);
    blobCache.set(key, { blob, size: blob.size, expiresAt: Date.now() + CONFIG.BLOB_CACHE_TTL_MS });
    blobCacheBytes += blob.size;
    while (blobCache.size > CONFIG.BLOB_CACHE_MAX_ENTRIES || blobCacheBytes > CONFIG.BLOB_CACHE_MAX_BYTES) {
      const oldest = blobCache.keys().next().value;
      if (oldest === undefined) break;
      removeBlobCacheEntry(oldest);
    }
  }

  function clearBlobCache() { blobCache.clear(); blobCacheBytes = 0; }

  // ============================================================
  // GM_xmlhttpRequest
  // ============================================================

  function isRetryableStatus(status) {
    return status === 0 || status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
  }

  function isUsableBlob(blob) {
    if (!blob || typeof blob.size !== 'number' || blob.size <= 0) return false;
    const t = String(blob.type || '').toLowerCase();
    return !t.startsWith('text/html') && !t.startsWith('application/json') && !t.startsWith('application/problem+json');
  }

  function requestBlobOnce(resourceURL) {
    return requestQueue.add(() => new Promise(resolve => {
      let settled = false;
      let handle = null;
      let watchdog = null;

      const finish = result => {
        if (settled) return;
        settled = true;
        if (watchdog !== null) clearTimeout(watchdog);
        resolve(result);
      };

      watchdog = setTimeout(() => {
        try { handle?.abort?.(); } catch {}
        finish({ ok: false, blob: null, status: 0, retryable: true, reason: 'watchdog-timeout' });
      }, CONFIG.REQUEST_TIMEOUT_MS + 1_000);

      try {
        handle = GM_xmlhttpRequest({
          method: 'GET',
          url: proxyURL(resourceURL),
          responseType: 'blob',
          timeout: CONFIG.REQUEST_TIMEOUT_MS,
          anonymous: true,
          headers: {
            accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
          },
          onload: res => {
            try {
              const status = Number(res?.status || 0);
              const blob = res?.response || null;
              const success = status >= 200 && status < 300 && isUsableBlob(blob);
              finish({ ok: success, blob: success ? blob : null, status, retryable: !success && isRetryableStatus(status), reason: success ? 'success' : 'invalid-response' });
            } catch (e) { finish({ ok: false, blob: null, status: 0, retryable: true, reason: e }); }
          },
          onerror: () => finish({ ok: false, blob: null, status: 0, retryable: true, reason: 'network-error' }),
          ontimeout: () => finish({ ok: false, blob: null, status: 0, retryable: true, reason: 'timeout' }),
          onabort: () => finish({ ok: false, blob: null, status: 0, retryable: true, reason: 'abort' })
        });
      } catch (e) { finish({ ok: false, blob: null, status: 0, retryable: true, reason: e }); }
    }));
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function loadBlobWithRetry(resourceURL) {
    for (let i = 0; i < CONFIG.MAX_ATTEMPTS; i++) {
      const result = await requestBlobOnce(resourceURL);
      if (result.ok && result.blob) return result.blob;
      if (!result.retryable || i >= CONFIG.MAX_ATTEMPTS - 1) return null;
      await sleep(CONFIG.RETRY_DELAYS_MS[Math.min(i, CONFIG.RETRY_DELAYS_MS.length - 1)] || 1000);
    }
    return null;
  }

  function fetchBlob(url) {
    let key;
    try { key = normalizeResourceURL(url); } catch { return Promise.resolve(null); }
    const cached = getCachedBlob(key);
    if (cached) return Promise.resolve(cached);
    const existing = inflightRequests.get(key);
    if (existing) return existing;
    const p = loadBlobWithRetry(key).then(blob => { if (blob) setCachedBlob(key, blob); return blob; }).catch(e => { warn('fetchBlob 异常：', key, e); return null; });
    inflightRequests.set(key, p);
    const cleanup = () => { if (inflightRequests.get(key) === p) inflightRequests.delete(key); };
    p.then(cleanup, cleanup);
    return p;
  }

  // ============================================================
  // srcset 解析
  // ============================================================

  function isHTMLSpace(c) { return c === '\t' || c === '\n' || c === '\f' || c === '\r' || c === ' '; }

  function parseSrcset(input) {
    const candidates = [];
    const src = String(input || '');
    let i = 0;
    while (i < src.length) {
      while (i < src.length && (isHTMLSpace(src[i]) || src[i] === ',')) i++;
      if (i >= src.length) break;
      let url = '';
      while (i < src.length && !isHTMLSpace(src[i])) { url += src[i]; i++; }
      if (!url) continue;
      const trailing = url.match(/,+$/)?.[0] || '';
      if (trailing) {
        url = url.slice(0, -trailing.length);
        if (url) candidates.push({ url, descriptor: '' });
        continue;
      }
      const descriptors = [];
      let cur = '';
      let depth = 0;
      while (i < src.length) {
        const c = src[i];
        if (c === '(') { depth++; cur += c; i++; continue; }
        if (c === ')') { if (depth > 0) depth--; cur += c; i++; continue; }
        if (c === ',' && depth === 0) { if (cur.trim()) descriptors.push(cur.trim()); cur = ''; i++; break; }
        if (isHTMLSpace(c) && depth === 0) { if (cur.trim()) descriptors.push(cur.trim()); cur = ''; i++; continue; }
        cur += c; i++;
      }
      if (cur.trim()) descriptors.push(cur.trim());
      candidates.push({ url, descriptor: descriptors.join(' ') });
    }
    return candidates;
  }

  function serializeSrcset(candidates) {
    return candidates.map(c => c.descriptor ? `${c.url} ${c.descriptor}` : c.url).join(', ');
  }

  // ============================================================
  // DOM 属性状态与 Blob URL 生命周期
  // ============================================================

  const attributeStates = new WeakMap();

  function getState(el, attr, create = true) {
    let map = attributeStates.get(el);
    if (!map) {
      if (!create) return null;
      map = new Map();
      attributeStates.set(el, map);
    }
    let state = map.get(attr);
    if (!state && create) {
      state = { version: 0, applied: null, sourceValue: null, objectURLs: [], pendingInput: null, pendingPromise: null };
      map.set(attr, state);
    }
    return state || null;
  }

  function revokeURL(url) { try { URL.revokeObjectURL(url); } catch {} }

  function releaseURLs(state) {
    if (!state?.objectURLs?.length) return;
    for (const url of state.objectURLs) revokeURL(url);
    state.objectURLs = [];
  }

  function syncState(el, attr) {
    const state = getState(el, attr, false);
    if (!state) return;
    const cur = el.getAttribute(attr);
    let changed = false;
    if (state.applied !== null && cur !== state.applied) { releaseURLs(state); state.applied = null; state.sourceValue = null; changed = true; }
    if (state.pendingInput !== null && cur !== state.pendingInput && cur !== state.applied) { state.pendingInput = null; state.pendingPromise = null; changed = true; }
    if (changed) state.version++;
  }

  function cleanupState(el, attr) {
    const state = getState(el, attr, false);
    if (!state) return;
    state.version++;
    const cur = el.getAttribute(attr);
    if (state.applied !== null && cur === state.applied && state.sourceValue !== null) {
      try { el.setAttribute(attr, state.sourceValue); } catch {}
    }
    releaseURLs(state);
    state.applied = null;
    state.sourceValue = null;
    state.pendingInput = null;
    state.pendingPromise = null;
  }

  function applyResult({ el, attr, originalValue, outputValue, objectURLs, state, version }) {
    if (!el.isConnected || state.version !== version || el.getAttribute(attr) !== originalValue) {
      for (const url of objectURLs) revokeURL(url);
      return false;
    }
    try {
      state.sourceValue = originalValue;
      state.objectURLs = objectURLs;
      state.applied = outputValue;
      el.setAttribute(attr, outputValue);
      return true;
    } catch (e) {
      state.sourceValue = null;
      state.objectURLs = [];
      state.applied = null;
      for (const url of objectURLs) revokeURL(url);
      warn('写入属性失败：', attr, e);
      return false;
    }
  }

  // ============================================================
  // 单 URL 属性代理
  // ============================================================

  function attrContainsProxy(el, attr) {
    syncState(el, attr);
    const state = getState(el, attr, false);
    const val = el.getAttribute(attr);
    if (!val) return false;
    if (state && state.applied !== null && val === state.applied) return false;
    try { return shouldProxy(new URL(val, document.baseURI)); } catch { return false; }
  }

  async function rewriteURLAttr(el, attr) {
    syncState(el, attr);
    const original = el.getAttribute(attr);
    if (!original) return false;
    const state = getState(el, attr);
    if (state.applied !== null && original === state.applied) return true;
    if (state.pendingInput === original && state.pendingPromise) return state.pendingPromise;
    let url;
    try { url = new URL(original, document.baseURI); } catch { return false; }
    if (!shouldProxy(url)) return false;
    const version = ++state.version;
    state.pendingInput = original;
    const p = (async () => {
      try {
        const blob = await fetchBlob(url.href);
        if (!blob) return false;
        if (state.version !== version || !el.isConnected || el.getAttribute(attr) !== original) return false;
        let objectURL;
        try { objectURL = URL.createObjectURL(blob); } catch (e) { warn('创建 Blob URL 失败：', e); return false; }
        return applyResult({ el, attr, originalValue: original, outputValue: objectURL + url.hash, objectURLs: [objectURL], state, version });
      } catch (e) { warn('单 URL 代理失败：', e); return false; } finally {
        if (state.version === version && state.pendingInput === original) { state.pendingInput = null; state.pendingPromise = null; }
      }
    })();
    state.pendingPromise = p;
    return p;
  }

  // ============================================================
  // srcset 代理
  // ============================================================

  function srcsetContainsProxy(el, attr = 'srcset') {
    syncState(el, attr);
    const state = getState(el, attr, false);
    const val = el.getAttribute(attr);
    if (!val) return false;
    if (state && state.applied !== null && val === state.applied) return false;
    return parseSrcset(val).some(c => { try { return shouldProxy(new URL(c.url, document.baseURI)); } catch { return false; } });
  }

  async function rewriteSrcset(el, attr = 'srcset') {
    syncState(el, attr);
    const original = el.getAttribute(attr);
    if (!original) return false;
    const state = getState(el, attr);
    if (state.applied !== null && original === state.applied) return true;
    if (state.pendingInput === original && state.pendingPromise) return state.pendingPromise;
    const candidates = parseSrcset(original);
    if (!candidates.length) return false;
    if (!candidates.some(c => { try { return shouldProxy(new URL(c.url, document.baseURI)); } catch { return false; } })) return false;
    const version = ++state.version;
    state.pendingInput = original;
    const p = (async () => {
      try {
        const loaded = await Promise.all(candidates.map(async c => {
          let url;
          try { url = new URL(c.url, document.baseURI); } catch { return { c, url: null, blob: null, rw: false }; }
          if (!shouldProxy(url)) return { c, url, blob: null, rw: false };
          return { c, url, blob: await fetchBlob(url.href), rw: true };
        }));
        if (state.version !== version || !el.isConnected || el.getAttribute(attr) !== original) return false;
        const output = [];
        const urls = [];
        let count = 0;
        try {
          for (const item of loaded) {
            if (item.rw && item.blob && item.url) {
              const u = URL.createObjectURL(item.blob);
              urls.push(u);
              count++;
              output.push({ url: u + item.url.hash, descriptor: item.c.descriptor });
            } else {
              output.push({ url: item.c.url, descriptor: item.c.descriptor });
            }
          }
        } catch (e) {
          for (const u of urls) revokeURL(u);
          warn('创建 srcset Blob URL 失败：', e);
          return false;
        }
        if (count === 0) { for (const u of urls) revokeURL(u); return false; }
        return applyResult({ el, attr, originalValue: original, outputValue: serializeSrcset(output), objectURLs: urls, state, version });
      } catch (e) { warn('srcset 代理失败：', e); return false; } finally {
        if (state.version === version && state.pendingInput === original) { state.pendingInput = null; state.pendingPromise = null; }
      }
    })();
    state.pendingPromise = p;
    return p;
  }

  // ============================================================
  // picture/img 处理
  // ============================================================

  function getPictureSources(img) {
    const p = img.parentElement;
    if (!p || p.tagName !== 'PICTURE') return [];
    return Array.from(p.children).filter(e => e.tagName === 'SOURCE');
  }

  function getPictureImage(src) {
    const p = src.parentElement;
    if (!p || p.tagName !== 'PICTURE') return null;
    return Array.from(p.children).find(e => e.tagName === 'IMG') || null;
  }

  function syncImageFamily(img) {
    syncState(img, 'src');
    syncState(img, 'srcset');
    for (const s of getPictureSources(img)) syncState(s, 'srcset');
  }

  function imageHasProxy(img) {
    syncImageFamily(img);
    if (attrContainsProxy(img, 'src')) return true;
    if (srcsetContainsProxy(img, 'srcset')) return true;
    for (const s of getPictureSources(img)) {
      if (srcsetContainsProxy(s, 'srcset')) return true;
    }
    return false;
  }

  async function rewriteResponsiveImage(img) {
    if (!img?.isConnected) return;
    syncImageFamily(img);
    const tasks = [];
    if (attrContainsProxy(img, 'src')) tasks.push(rewriteURLAttr(img, 'src'));
    if (srcsetContainsProxy(img, 'srcset')) tasks.push(rewriteSrcset(img, 'srcset'));
    for (const s of getPictureSources(img)) {
      if (srcsetContainsProxy(s, 'srcset')) tasks.push(rewriteSrcset(s, 'srcset'));
    }
    if (!tasks.length) return;
    await Promise.allSettled(tasks);
  }

  // ============================================================
  // 视口懒加载
  // ============================================================

  const imageObserver = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(entries => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          imageObserver.unobserve(e.target);
          void rewriteResponsiveImage(e.target);
        }
      }, { rootMargin: CONFIG.IMAGE_ROOT_MARGIN })
    : null;

  function handleImage(img) {
    if (!img || img.tagName !== 'IMG') return;
    syncImageFamily(img);
    if (!imageHasProxy(img)) { imageObserver?.unobserve(img); return; }
    if (imageObserver) imageObserver.observe(img);
    else void rewriteResponsiveImage(img);
  }

  function handleSource(src) {
    if (!src || src.tagName !== 'SOURCE') return;
    syncState(src, 'srcset');
    const img = getPictureImage(src);
    if (img) handleImage(img);
  }

  // ============================================================
  // 下载链接处理
  // ============================================================

  function rewriteLink(a) {
    if (!a || a.tagName !== 'A' || !a.hasAttribute('href')) return;
    const href = a.getAttribute('href');
    if (!href) return;
    try {
      const url = new URL(href, document.baseURI);
      if (!shouldProxy(url)) return;
      const proxy = proxyURL(url);
      if (a.getAttribute('href') !== proxy) a.setAttribute('href', proxy);
    } catch { /* ignore */ }
  }

  // ============================================================
  // 元素清理
  // ============================================================

  function cleanupElement(el) {
    if (!el || el.nodeType !== 1) return;
    if (el.tagName === 'IMG') {
      imageObserver?.unobserve(el);
      cleanupState(el, 'src');
      cleanupState(el, 'srcset');
    } else if (el.tagName === 'SOURCE') {
      cleanupState(el, 'srcset');
    }
  }

  // ============================================================
  // Shadow DOM
  // ============================================================

  const observedRoots = new WeakSet();
  const rootObservers = new WeakMap();
  const knownShadowRoots = new WeakMap();

  function disconnectRoot(root) {
    if (!root || root === document) return;
    const obs = rootObservers.get(root);
    if (obs) { obs.disconnect(); rootObservers.delete(root); }
    observedRoots.delete(root);
  }

  function registerShadowRoot(host, root) {
    if (!host || !root) return;
    knownShadowRoots.set(host, root);
    observeRoot(root);
  }

  function patchAttachShadow() {
    try {
      const proto = Element.prototype;
      const orig = proto.attachShadow;
      if (typeof orig !== 'function' || orig.__githubProxyPatched) return;
      function patched(init) {
        const root = orig.call(this, init);
        try { registerShadowRoot(this, root); } catch {}
        return root;
      }
      Object.defineProperty(patched, '__githubProxyPatched', { value: true });
      proto.attachShadow = patched;
    } catch (e) { warn('attachShadow 拦截失败：', e); }
  }

  // ============================================================
  // DOM 扫描
  // ============================================================

  function processElement(el) {
    switch (el.tagName) {
      case 'IMG': handleImage(el); break;
      case 'SOURCE': handleSource(el); break;
      case 'A': rewriteLink(el); break;
    }
  }

  function discoverShadow(el) {
    if (!el || el.nodeType !== 1) return;
    const root = el.shadowRoot || knownShadowRoots.get(el);
    if (root) registerShadowRoot(el, root);
  }

  function scan(root) {
    if (!root || ![1, 9, 11].includes(root.nodeType)) return;
    if (root.nodeType === 1) { processElement(root); discoverShadow(root); }
    root.querySelectorAll?.('img, source, a[href]').forEach(processElement);
    root.querySelectorAll?.('*').forEach(discoverShadow);
  }

  function cleanupTree(root) {
    if (!root) return;
    if (root.nodeType === 11 && root !== document) disconnectRoot(root);
    if (root.nodeType === 1) {
      cleanupElement(root);
      const sr = root.shadowRoot || knownShadowRoots.get(root);
      if (sr) cleanupTree(sr);
    }
    root.querySelectorAll?.('img, source').forEach(cleanupElement);
    root.querySelectorAll?.('*').forEach(el => {
      const sr = el.shadowRoot || knownShadowRoots.get(el);
      if (sr) cleanupTree(sr);
    });
  }

  function scheduleCleanup(node) {
    queueMicrotask(() => { if (!node.isConnected) cleanupTree(node); });
  }

  // ============================================================
  // 事件委托
  // ============================================================

  const DELEGATED_EVENTS = ['pointerover', 'pointerdown', 'focusin', 'contextmenu', 'dragstart', 'click', 'auxclick'];

  function delegatedHandler(e) {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    let a = path.find(n => n?.tagName === 'A' && n.hasAttribute?.('href'));
    if (!a && e.target?.closest) a = e.target.closest('a[href]');
    if (a) rewriteLink(a);
  }

  function installDelegatedEvents(root) {
    for (const ev of DELEGATED_EVENTS) root.addEventListener(ev, delegatedHandler, true);
  }

  // ============================================================
  // MutationObserver
  // ============================================================

  function handleMutations(mutations) {
    for (const m of mutations) {
      if (m.type === 'attributes') {
        const t = m.target;
        if (t.tagName === 'A' && m.attributeName === 'href') { rewriteLink(t); continue; }
        if (t.tagName === 'IMG' && (m.attributeName === 'src' || m.attributeName === 'srcset')) { handleImage(t); continue; }
        if (t.tagName === 'SOURCE' && m.attributeName === 'srcset') handleSource(t);
        continue;
      }
      if (m.type === 'childList') {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1 || n.nodeType === 11) scan(n);
        }
        for (const n of m.removedNodes) {
          if (n.nodeType === 1 || n.nodeType === 11) scheduleCleanup(n);
        }
      }
    }
  }

  function observeRoot(root) {
    if (!root || observedRoots.has(root)) return;
    observedRoots.add(root);
    const obs = new MutationObserver(handleMutations);
    obs.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'src', 'srcset'] });
    rootObservers.set(root, obs);
    installDelegatedEvents(root);
    scan(root);
  }

  // ============================================================
  // 初始化
  // ============================================================

  patchAttachShadow();
  observeRoot(document);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => scan(document), { once: true });
  } else {
    scan(document);
  }

  window.addEventListener('pagehide', e => {
    if (!e.persisted) { clearBlobCache(); inflightRequests.clear(); }
  });
})();
