// ==UserScript==
// @name         GitHub 下载与图片代理
// @namespace    https://xiaosh.xyz/
// @version      6.1.0
// @description  代理 GitHub 下载链接与图片；Blob/data 双通道、srcset 与 picture 完整支持、懒加载、Shadow DOM、SPA 与延迟回收
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

  const CONFIG = {
    // 代理服务必须直接返回资源内容，不能重定向回原始 GitHub 地址，
    // 否则 CDN 页面跳转会形成死循环。
    PROXY: 'https://github-proxy.xiaosh.xyz/?url=',

    // 客户端并发上限。这是本页面的策略，不等于 Worker 的连接限制。
    CLIENT_CONCURRENCY: 6,

    // 单次请求超时。
    REQUEST_TIMEOUT_MS: 30_000,

    // 总尝试次数 = 首次 + 重试。
    MAX_ATTEMPTS: 3,
    RETRY_DELAYS_MS: [600, 1_500],

    // Blob 数据缓存（缓存 Blob 本身，不缓存 Blob URL）。
    BLOB_CACHE_MAX_ENTRIES: 256,
    BLOB_CACHE_MAX_BYTES: 96 * 1024 * 1024,
    BLOB_CACHE_TTL_MS: 10 * 60 * 1_000,

    // 提前处理即将进入视口的图片。
    IMAGE_ROOT_MARGIN: '300px',

    // 元素脱离文档后的 Blob URL 宽限期。
    // 期间元素若被重新插入，Blob 仍可直接复用。
    REVOKE_GRACE_MS: 45_000,
    REVOKE_SWEEP_INTERVAL_MS: 15_000,

    // Shadow Root 全量遍历的最小间隔。
    SHADOW_WALK_MIN_INTERVAL_MS: 3_000,

    // 是否代理头像与 camo 徽章。
    // 关闭可显著降低代理流量，但这些图在部分网络下会加载失败。
    PROXY_AVATARS: true,

    DEBUG: false
  };

  const PROXY_HOST = new URL(CONFIG.PROXY).hostname;

  function debug(...args) {
    if (CONFIG.DEBUG) {
      console.debug('[GitHub Proxy]', ...args);
    }
  }

  function warn(...args) {
    if (CONFIG.DEBUG) {
      console.warn('[GitHub Proxy]', ...args);
    }
  }

  // ============================================================
  // URL 判定
  // ============================================================

  function isGitHubCDN(hostname) {
    return (
      /(^|\.)githubusercontent\.com$/i.test(hostname) ||
      /^codeload\.github\.com$/i.test(hostname)
    );
  }

  function isAvatarLikeHost(hostname) {
    return (
      /^avatars\d*\.githubusercontent\.com$/i.test(hostname) ||
      /^camo\.githubusercontent\.com$/i.test(hostname)
    );
  }

  function isGitHubPageHost(hostname) {
    return (
      hostname === 'github.com' ||
      hostname === 'gist.github.com'
    );
  }

  /**
   * ?raw / ?raw=1 / ?raw=true 视为有效；?raw=0 / ?raw=false 不算。
   */
  function hasRawFlag(url) {
    if (!url.searchParams.has('raw')) {
      return false;
    }

    const value = url.searchParams.get('raw');

    return (
      value === '' ||
      value === '1' ||
      /^true$/i.test(value)
    );
  }

  // pathname 不含 query，所以不需要匹配 ?。
  const IMAGE_EXTENSION =
    /\.(?:apng|avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i;

  /**
   * 下载路径判定。全部使用 ^ 锚定，
   * 避免 profiles/ 命中 files/、notassets/ 命中 assets/。
   */
  function isDownloadPath(url) {
    const path = url.pathname;

    if (url.hostname === 'github.com') {
      return (
        // /owner/repo/releases/download/tag/file
        // /owner/repo/releases/latest/download/file
        /^\/[^/]+\/[^/]+\/releases\/(?:latest\/)?download(?:\/|$)/i.test(path) ||

        // /owner/repo/{archive,zipball,tarball,raw}/...
        /^\/[^/]+\/[^/]+\/(?:archive|zipball|tarball|raw)(?:\/|$)/i.test(path) ||

        // 旧式仓库附件 /owner/repo/{files,assets}/...
        /^\/[^/]+\/[^/]+\/(?:files|assets)(?:\/|$)/i.test(path) ||

        // 新式用户附件 /user-attachments/{files,assets}/...
        /^\/user-attachments\/(?:files|assets)(?:\/|$)/i.test(path)

        // 注意：不匹配顶层 /files/ 与 /assets/。
        // 那两条会把 GitHub 普通页面误判成下载资源，
        // 一旦改写 <a href> 就会破坏正常导航。
      );
    }

    if (url.hostname === 'gist.github.com') {
      return /^\/[^/]+\/[^/]+\/(?:archive|raw)(?:\/|$)/i.test(path);
    }

    return false;
  }

  function shouldProxy(url) {
    if (!(url instanceof URL)) {
      return false;
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return false;
    }

    // 避免重复套代理。
    if (url.hostname === PROXY_HOST) {
      return false;
    }

    if (isGitHubCDN(url.hostname)) {
      if (!CONFIG.PROXY_AVATARS && isAvatarLikeHost(url.hostname)) {
        return false;
      }

      return true;
    }

    if (!isGitHubPageHost(url.hostname)) {
      return false;
    }

    // tree 是目录页，不是资源。
    if (url.pathname.includes('/tree/')) {
      return false;
    }

    // blob 是代码浏览页，只有带有效 raw 参数时才是资源。
    if (url.pathname.includes('/blob/')) {
      return hasRawFlag(url);
    }

    if (hasRawFlag(url)) {
      return true;
    }

    return (
      isDownloadPath(url) ||
      IMAGE_EXTENSION.test(url.pathname)
    );
  }

  function proxyURL(target) {
    const href = target instanceof URL ? target.href : String(target);
    return CONFIG.PROXY + encodeURIComponent(href);
  }

  function parseURL(value) {
    try {
      return new URL(value, document.baseURI);
    } catch {
      return null;
    }
  }

  function isProxyableValue(value) {
    if (!value) {
      return false;
    }

    const url = parseURL(value);
    return url !== null && shouldProxy(url);
  }

  /**
   * 请求与缓存键去掉 fragment：hash 不会发送到服务器。
   * 写回 DOM 时会重新拼上原 hash。
   */
  function normalizeResourceURL(value) {
    const url = value instanceof URL ? new URL(value.href) : parseURL(value);

    if (!url) {
      return null;
    }

    url.hash = '';
    return url.href;
  }

  // ============================================================
  // 直接访问 CDN / codeload 时整页跳转
  // ============================================================

  if (isGitHubCDN(location.hostname)) {
    const currentURL = parseURL(location.href);

    if (currentURL && shouldProxy(currentURL)) {
      location.replace(proxyURL(currentURL));
    }

    return;
  }

  // ============================================================
  // 并发队列
  // ============================================================

  class RequestQueue {
    constructor(maxConcurrency) {
      this.maxConcurrency = maxConcurrency;
      this.activeCount = 0;
      this.tasks = [];
    }

    add(task) {
      return new Promise((resolve, reject) => {
        this.tasks.push({ task, resolve, reject });
        this.run();
      });
    }

    run() {
      while (
        this.activeCount < this.maxConcurrency &&
        this.tasks.length > 0
      ) {
        const item = this.tasks.shift();

        this.activeCount++;

        Promise.resolve()
          .then(item.task)
          .then(item.resolve, item.reject)
          .finally(() => {
            this.activeCount--;
            this.run();
          });
      }
    }
  }

  const requestQueue = new RequestQueue(CONFIG.CLIENT_CONCURRENCY);

  // ============================================================
  // Blob 类型补正
  // ============================================================

  const EXTENSION_MIME = {
    apng: 'image/apng',
    avif: 'image/avif',
    bmp: 'image/bmp',
    gif: 'image/gif',
    ico: 'image/x-icon',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    png: 'image/png',
    svg: 'image/svg+xml',
    webp: 'image/webp'
  };

  function guessMimeFromURL(value) {
    const url = parseURL(value);

    if (!url) {
      return null;
    }

    const match = url.pathname.match(/\.([a-z0-9]+)$/i);

    if (!match) {
      return null;
    }

    return EXTENSION_MIME[match[1].toLowerCase()] || null;
  }

  /**
   * raw.githubusercontent.com 会把 .svg 返回成 text/plain。
   * 这类 Blob 直接交给 <img> 存在渲染失败风险，按扩展名补正类型。
   */
  function normalizeBlobType(blob, sourceURL) {
    const type = String(blob.type || '').toLowerCase();

    if (type.startsWith('image/')) {
      return blob;
    }

    const guessed = guessMimeFromURL(sourceURL);

    if (!guessed) {
      return blob;
    }

    try {
      return new Blob([blob], { type: guessed });
    } catch {
      return blob;
    }
  }

  // ============================================================
  // Blob TTL + LRU 缓存
  // ============================================================

  const blobCache = new Map();
  const inflightRequests = new Map();

  let blobCacheBytes = 0;

  function removeBlobCacheEntry(key) {
    const entry = blobCache.get(key);

    if (!entry) {
      return;
    }

    blobCache.delete(key);
    blobCacheBytes = Math.max(0, blobCacheBytes - entry.size);
  }

  function getCachedBlob(key) {
    const entry = blobCache.get(key);

    if (!entry) {
      return null;
    }

    if (Date.now() >= entry.expiresAt) {
      removeBlobCacheEntry(key);
      return null;
    }

    // 删除后重新插入以刷新 LRU 顺序。
    blobCache.delete(key);
    blobCache.set(key, entry);

    return entry.blob;
  }

  function setCachedBlob(key, blob) {
    if (!blob || !(blob.size > 0)) {
      return;
    }

    if (blob.size > CONFIG.BLOB_CACHE_MAX_BYTES) {
      return;
    }

    removeBlobCacheEntry(key);

    blobCache.set(key, {
      blob,
      size: blob.size,
      expiresAt: Date.now() + CONFIG.BLOB_CACHE_TTL_MS
    });

    blobCacheBytes += blob.size;

    while (
      blobCache.size > CONFIG.BLOB_CACHE_MAX_ENTRIES ||
      blobCacheBytes > CONFIG.BLOB_CACHE_MAX_BYTES
    ) {
      const oldestKey = blobCache.keys().next().value;

      if (oldestKey === undefined) {
        break;
      }

      removeBlobCacheEntry(oldestKey);
    }
  }

  // ============================================================
  // GM 请求
  // ============================================================

  function isRetryableStatus(status) {
    return (
      status === 0 ||
      status === 408 ||
      status === 425 ||
      status === 429 ||
      (status >= 500 && status <= 599)
    );
  }

  function isUsableBlob(blob) {
    if (!blob || !(blob.size > 0)) {
      return false;
    }

    const type = String(blob.type || '').toLowerCase();

    // 代理返回的 HTML/JSON 错误页不能当成图片。
    return !(
      type.startsWith('text/html') ||
      type.startsWith('application/json') ||
      type.startsWith('application/problem+json')
    );
  }

  /**
   * 单次请求。
   *
   * 除 GM 自带 timeout 外另加外层看门狗：
   * 部分管理器在 fetch 模式下 timeout 不生效，
   * 请求悬挂会永久占用一个并发位。
   */
  function requestBlobOnce(resourceURL) {
    return requestQueue.add(() => new Promise(resolve => {
      let settled = false;
      let handle = null;
      let watchdog = null;

      const finish = result => {
        if (settled) {
          return;
        }

        settled = true;

        if (watchdog !== null) {
          clearTimeout(watchdog);
          watchdog = null;
        }

        resolve(result);
      };

      const fail = (reason, retryable = true, status = 0) => {
        finish({ ok: false, blob: null, status, retryable, reason });
      };

      watchdog = setTimeout(() => {
        try {
          handle?.abort?.();
        } catch {
          // 忽略 abort 异常。
        }

        fail('watchdog-timeout');
      }, CONFIG.REQUEST_TIMEOUT_MS + 2_000);

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

          onload: response => {
            try {
              const status = Number(response?.status || 0);
              const blob = response?.response || null;
              const ok = status >= 200 && status < 300 && isUsableBlob(blob);

              if (ok) {
                finish({
                  ok: true,
                  blob: normalizeBlobType(blob, resourceURL),
                  status,
                  retryable: false,
                  reason: 'success'
                });
              } else {
                fail('invalid-response', isRetryableStatus(status), status);
              }
            } catch (error) {
              fail(error);
            }
          },

          onerror: () => fail('network-error'),
          ontimeout: () => fail('timeout'),
          onabort: () => fail('abort')
        });
      } catch (error) {
        fail(error);
      }
    }));
  }

  function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
  }

  async function loadBlobWithRetry(resourceURL) {
    for (let attempt = 0; attempt < CONFIG.MAX_ATTEMPTS; attempt++) {
      const result = await requestBlobOnce(resourceURL);

      if (result.ok && result.blob) {
        return result.blob;
      }

      const isLast = attempt >= CONFIG.MAX_ATTEMPTS - 1;

      if (!result.retryable || isLast) {
        debug('请求失败：', resourceURL, result.status, result.reason);
        return null;
      }

      const index = Math.min(attempt, CONFIG.RETRY_DELAYS_MS.length - 1);
      await sleep(CONFIG.RETRY_DELAYS_MS[index] || 1_500);
    }

    return null;
  }

  /**
   * 同一 URL：
   *   1. 命中 TTL/LRU 缓存直接返回；
   *   2. 并发请求复用同一 Promise；
   *   3. 完成后清除 inflight，失败不会被永久缓存。
   */
  function fetchBlob(value) {
    const key = normalizeResourceURL(value);

    if (!key) {
      return Promise.resolve(null);
    }

    const cached = getCachedBlob(key);

    if (cached) {
      return Promise.resolve(cached);
    }

    const existing = inflightRequests.get(key);

    if (existing) {
      return existing;
    }

    const promise = loadBlobWithRetry(key)
      .then(blob => {
        if (blob) {
          setCachedBlob(key, blob);
        }

        return blob;
      })
      .catch(error => {
        warn('fetchBlob 异常：', key, error);
        return null;
      });

    inflightRequests.set(key, promise);

    const clear = () => {
      if (inflightRequests.get(key) === promise) {
        inflightRequests.delete(key);
      }
    };

    promise.then(clear, clear);

    return promise;
  }

  // ============================================================
  // blob: 可用性探针与资源物化
  // ============================================================

  /**
   * 页面 CSP 的 img-src 是否允许 blob: 无法静态断定。
   * 这里用一个 1x1 PNG 实测：
   *   能加载   → 使用 blob URL；
   *   被拦截   → 整体降级为 data: URL。
   */
  const PROBE_PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

  let materializeMode = null;
  let probePromise = null;

  function base64ToBlob(base64, type) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    return new Blob([bytes], { type });
  }

  function probeMaterializeMode() {
    if (probePromise) {
      return probePromise;
    }

    probePromise = new Promise(resolve => {
      let objectURL = null;
      let done = false;

      const finish = mode => {
        if (done) {
          return;
        }

        done = true;

        if (objectURL) {
          revokeIfObjectURL(objectURL);
        }

        debug('资源物化方式：', mode);
        resolve(mode);
      };

      try {
        const blob = base64ToBlob(PROBE_PNG_BASE64, 'image/png');
        objectURL = URL.createObjectURL(blob);

        const probe = new Image();
        probe.onload = () => finish('blob');
        probe.onerror = () => finish('data');

        // 探针无响应时按 blob 处理，避免整体退化到体积更大的 data URL。
        setTimeout(() => finish('blob'), 3_000);

        probe.src = objectURL;
      } catch (error) {
        warn('blob 探针失败：', error);
        finish('data');
      }
    }).then(mode => {
      materializeMode = mode;
      return mode;
    });

    return probePromise;
  }

  function blobToDataURL(blob) {
    return new Promise(resolve => {
      try {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || '') || null);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      } catch {
        resolve(null);
      }
    });
  }

  function revokeIfObjectURL(value) {
    if (typeof value !== 'string' || !value.startsWith('blob:')) {
      return;
    }

    try {
      URL.revokeObjectURL(value);
    } catch {
      // 已释放或无效时忽略。
    }
  }

  /**
   * 把 Blob 转成可写入 DOM 的值。
   * revocable 为 true 时需要在生命周期结束时 revoke。
   */
  async function materializeBlob(blob) {
    const mode = materializeMode || await probeMaterializeMode();

    if (mode === 'blob') {
      try {
        return { value: URL.createObjectURL(blob), revocable: true };
      } catch (error) {
        warn('createObjectURL 失败：', error);
        return null;
      }
    }

    const dataURL = await blobToDataURL(blob);

    return dataURL ? { value: dataURL, revocable: false } : null;
  }

  function releaseValues(values) {
    for (const value of values || []) {
      revokeIfObjectURL(value);
    }
  }

  // ============================================================
  // 延迟回收
  // ============================================================

  /**
   * 元素脱离文档时不立即 revoke，也不把原始 URL 写回 DOM。
   *
   * 写回原始 URL 会让脱离文档的 <img> 重新发起原始请求，
   * 这正是脚本要避免的行为。
   */
  const pendingRevocations = [];
  let sweeperTimer = null;

  const supportsWeakRef = typeof WeakRef === 'function';

  function startRevocationSweeper() {
    if (sweeperTimer !== null) {
      return;
    }

    sweeperTimer = setInterval(
      sweepRevocations,
      CONFIG.REVOKE_SWEEP_INTERVAL_MS
    );
  }

  function scheduleRevocation(element, attributeName, values) {
    if (!values?.length) {
      return;
    }

    pendingRevocations.push({
      attributeName,
      values: values.slice(),
      deadline: Date.now() + CONFIG.REVOKE_GRACE_MS,
      elementRef: supportsWeakRef ? new WeakRef(element) : null
    });

    startRevocationSweeper();
  }

  function sweepRevocations() {
    const now = Date.now();

    for (let i = pendingRevocations.length - 1; i >= 0; i--) {
      const entry = pendingRevocations[i];

      if (now < entry.deadline) {
        continue;
      }

      const element = entry.elementRef ? entry.elementRef.deref() : null;

      // 元素回到文档：撤销回收计划，状态里的 URL 继续有效。
      if (element && element.isConnected) {
        pendingRevocations.splice(i, 1);
        continue;
      }

      releaseValues(entry.values);

      if (element) {
        const state = getAttributeState(element, entry.attributeName, false);

        if (state && state.objectURLs === entry.values) {
          state.objectURLs = [];
        }

        if (state) {
          // applied 仍留在 DOM 属性上，但底层资源已释放。
          // 重新插入时按 revoked 走重新代理，而不是写回原始 URL。
          state.revoked = true;
        }
      }

      pendingRevocations.splice(i, 1);
    }

    if (!pendingRevocations.length && sweeperTimer !== null) {
      clearInterval(sweeperTimer);
      sweeperTimer = null;
    }
  }

  // ============================================================
  // srcset 解析
  // ============================================================

  function isHTMLSpace(character) {
    return (
      character === '\u0009' ||
      character === '\u000A' ||
      character === '\u000C' ||
      character === '\u000D' ||
      character === '\u0020'
    );
  }

  /**
   * 解析 srcset 候选列表，保留 1x / 2x / 400w 等描述符。
   */
  function parseSrcset(input) {
    const source = String(input || '');
    const candidates = [];

    let position = 0;

    while (position < source.length) {
      while (
        position < source.length &&
        (isHTMLSpace(source[position]) || source[position] === ',')
      ) {
        position++;
      }

      if (position >= source.length) {
        break;
      }

      let url = '';

      while (position < source.length && !isHTMLSpace(source[position])) {
        url += source[position];
        position++;
      }

      if (!url) {
        continue;
      }

      // "a.png," 这种无描述符候选。
      const trailingCommas = url.match(/,+$/)?.[0] || '';

      if (trailingCommas) {
        url = url.slice(0, -trailingCommas.length);

        if (url) {
          candidates.push({ url, descriptor: '' });
        }

        continue;
      }

      const descriptors = [];
      let current = '';
      let depth = 0;

      while (position < source.length) {
        const character = source[position];

        if (character === '(') {
          depth++;
          current += character;
          position++;
          continue;
        }

        if (character === ')') {
          depth = Math.max(0, depth - 1);
          current += character;
          position++;
          continue;
        }

        if (character === ',' && depth === 0) {
          if (current.trim()) {
            descriptors.push(current.trim());
          }

          current = '';
          position++;
          break;
        }

        if (isHTMLSpace(character) && depth === 0) {
          if (current.trim()) {
            descriptors.push(current.trim());
            current = '';
          }

          position++;
          continue;
        }

        current += character;
        position++;
      }

      if (current.trim()) {
        descriptors.push(current.trim());
      }

      candidates.push({ url, descriptor: descriptors.join(' ') });
    }

    return candidates;
  }

  function serializeSrcset(candidates) {
    return candidates
      .map(candidate => (
        candidate.descriptor
          ? `${candidate.url} ${candidate.descriptor}`
          : candidate.url
      ))
      .join(', ');
  }

  function srcsetHasProxyable(value) {
    return parseSrcset(value).some(candidate => isProxyableValue(candidate.url));
  }

  // ============================================================
  // 属性状态机
  // ============================================================

  /**
   * 每个 (元素, 属性) 独立维护：
   *
   *   version   异步请求版本，防止旧请求覆盖新值
   *   logical   原始 GitHub 侧的值（唯一真源）
   *   applied   脚本写入 DOM 的值
   *   objectURLs 需要回收的 blob URL
   *   revoked   底层资源已释放，需要重新代理
   */
  const attributeStates = new WeakMap();

  function getAttributeState(element, attributeName, create = true) {
    let stateMap = attributeStates.get(element);

    if (!stateMap) {
      if (!create) {
        return null;
      }

      stateMap = new Map();
      attributeStates.set(element, stateMap);
    }

    let state = stateMap.get(attributeName);

    if (!state && create) {
      state = {
        version: 0,
        logical: null,
        applied: null,
        objectURLs: [],
        revoked: false,
        pendingLogical: null,
        pendingPromise: null
      };

      stateMap.set(attributeName, state);
    }

    return state || null;
  }

  function getLogicalValue(element, attributeName, state) {
    const current = element.getAttribute(attributeName);

    if (state && state.applied !== null && current === state.applied) {
      return state.logical;
    }

    return current;
  }

  /**
   * 检测页面是否覆盖了脚本写入的属性。
   */
  function syncAttributeState(element, attributeName) {
    const state = getAttributeState(element, attributeName, false);

    if (!state) {
      return;
    }

    const current = element.getAttribute(attributeName);

    // 仍是脚本写入的值。
    if (state.applied !== null && current === state.applied) {
      return;
    }

    if (state.applied !== null) {
      // 页面已改写，DOM 不再引用旧资源，可以立即释放。
      releaseValues(state.objectURLs);

      state.objectURLs = [];
      state.applied = null;
      state.logical = null;
      state.revoked = false;
      state.pendingLogical = null;
      state.pendingPromise = null;
      state.version++;

      return;
    }

    if (state.pendingLogical !== null && current !== state.pendingLogical) {
      state.pendingLogical = null;
      state.pendingPromise = null;
      state.version++;
    }
  }

  function attributeNeedsProxy(element, attributeName, kind) {
    syncAttributeState(element, attributeName);

    const state = getAttributeState(element, attributeName, false);

    if (state && state.applied !== null && !state.revoked) {
      return false;
    }

    const logical = getLogicalValue(element, attributeName, state);

    if (!logical) {
      return false;
    }

    return kind === 'srcset'
      ? srcsetHasProxyable(logical)
      : isProxyableValue(logical);
  }

  function composeValue(materialized, resourceURL) {
    // hash 只对 blob URL 有意义，data URL 不拼接。
    if (materialized.value.startsWith('blob:') && resourceURL.hash) {
      return materialized.value + resourceURL.hash;
    }

    return materialized.value;
  }

  function commitAttribute({
    element,
    attributeName,
    state,
    version,
    domValueAtStart,
    logical,
    outputValue,
    revocables
  }) {
    const stillValid = (
      element.isConnected &&
      state.version === version &&
      element.getAttribute(attributeName) === domValueAtStart
    );

    if (!stillValid) {
      releaseValues(revocables);
      return false;
    }

    const previousURLs = state.objectURLs;

    try {
      // 先更新状态，保证 MutationObserver 回调能识别
      // 这次变更来自脚本自身而非页面覆盖。
      state.logical = logical;
      state.applied = outputValue;
      state.objectURLs = revocables;
      state.revoked = false;

      element.setAttribute(attributeName, outputValue);

      releaseValues(previousURLs);

      return true;
    } catch (error) {
      state.logical = null;
      state.applied = null;
      state.objectURLs = previousURLs;

      releaseValues(revocables);
      warn('写入属性失败：', attributeName, error);

      return false;
    }
  }

  // ============================================================
  // 单 URL 属性代理
  // ============================================================

  async function proxyURLAttribute(element, attributeName) {
    syncAttributeState(element, attributeName);

    const state = getAttributeState(element, attributeName);

    if (state.applied !== null && !state.revoked) {
      return true;
    }

    const logical = getLogicalValue(element, attributeName, state);

    if (!logical) {
      return false;
    }

    if (state.pendingLogical === logical && state.pendingPromise) {
      return state.pendingPromise;
    }

    const resourceURL = parseURL(logical);

    if (!resourceURL || !shouldProxy(resourceURL)) {
      return false;
    }

    const domValueAtStart = element.getAttribute(attributeName);
    const version = ++state.version;

    state.pendingLogical = logical;

    const promise = (async () => {
      try {
        const blob = await fetchBlob(resourceURL.href);

        if (!blob) {
          return false;
        }

        if (
          state.version !== version ||
          !element.isConnected ||
          element.getAttribute(attributeName) !== domValueAtStart
        ) {
          return false;
        }

        const materialized = await materializeBlob(blob);

        if (!materialized) {
          return false;
        }

        return commitAttribute({
          element,
          attributeName,
          state,
          version,
          domValueAtStart,
          logical,
          outputValue: composeValue(materialized, resourceURL),
          revocables: materialized.revocable ? [materialized.value] : []
        });
      } catch (error) {
        warn('单 URL 代理失败：', error);
        return false;
      } finally {
        if (state.version === version && state.pendingLogical === logical) {
          state.pendingLogical = null;
          state.pendingPromise = null;
        }
      }
    })();

    state.pendingPromise = promise;

    return promise;
  }

  // ============================================================
  // srcset 代理
  // ============================================================

  async function proxySrcsetAttribute(element, attributeName = 'srcset') {
    syncAttributeState(element, attributeName);

    const state = getAttributeState(element, attributeName);

    if (state.applied !== null && !state.revoked) {
      return true;
    }

    const logical = getLogicalValue(element, attributeName, state);

    if (!logical) {
      return false;
    }

    if (state.pendingLogical === logical && state.pendingPromise) {
      return state.pendingPromise;
    }

    const candidates = parseSrcset(logical);

    if (!candidates.length || !candidates.some(c => isProxyableValue(c.url))) {
      return false;
    }

    const domValueAtStart = element.getAttribute(attributeName);
    const version = ++state.version;

    state.pendingLogical = logical;

    const promise = (async () => {
      try {
        /**
         * 逐候选处理，descriptor 原样保留：
         *   a.png 1x, b.png 2x  →  blob:... 1x, blob:... 2x
         *
         * 代价是 <picture> 中所有需要代理的候选都会被下载，
         * 换来的是后续主题或 DPR 切换不会回落到原始地址。
         */
        const loaded = await Promise.all(candidates.map(async candidate => {
          const url = parseURL(candidate.url);

          if (!url || !shouldProxy(url)) {
            return { candidate, url, blob: null, target: false };
          }

          return {
            candidate,
            url,
            blob: await fetchBlob(url.href),
            target: true
          };
        }));

        if (
          state.version !== version ||
          !element.isConnected ||
          element.getAttribute(attributeName) !== domValueAtStart
        ) {
          return false;
        }

        const outputCandidates = [];
        const revocables = [];

        let successCount = 0;

        for (const item of loaded) {
          if (item.target && item.blob && item.url) {
            const materialized = await materializeBlob(item.blob);

            if (materialized) {
              if (materialized.revocable) {
                revocables.push(materialized.value);
              }

              successCount++;

              outputCandidates.push({
                url: composeValue(materialized, item.url),
                descriptor: item.candidate.descriptor
              });

              continue;
            }
          }

          // 失败或本不需要代理的候选原样保留。
          outputCandidates.push({
            url: item.candidate.url,
            descriptor: item.candidate.descriptor
          });
        }

        if (successCount === 0) {
          releaseValues(revocables);
          return false;
        }

        return commitAttribute({
          element,
          attributeName,
          state,
          version,
          domValueAtStart,
          logical,
          outputValue: serializeSrcset(outputCandidates),
          revocables
        });
      } catch (error) {
        warn('srcset 代理失败：', error);
        return false;
      } finally {
        if (state.version === version && state.pendingLogical === logical) {
          state.pendingLogical = null;
          state.pendingPromise = null;
        }
      }
    })();

    state.pendingPromise = promise;

    return promise;
  }

  // ============================================================
  // img / picture
  // ============================================================

  function getPictureSources(image) {
    const picture = image.parentElement;

    if (!picture || picture.tagName !== 'PICTURE') {
      return [];
    }

    return Array.from(picture.children).filter(el => el.tagName === 'SOURCE');
  }

  function getPictureImage(source) {
    const picture = source.parentElement;

    if (!picture || picture.tagName !== 'PICTURE') {
      return null;
    }

    return Array.from(picture.children).find(el => el.tagName === 'IMG') || null;
  }

  function imageHasProxyTarget(image) {
    if (attributeNeedsProxy(image, 'src', 'url')) {
      return true;
    }

    if (attributeNeedsProxy(image, 'srcset', 'srcset')) {
      return true;
    }

    return getPictureSources(image)
      .some(source => attributeNeedsProxy(source, 'srcset', 'srcset'));
  }

  async function proxyImageFamily(image) {
    if (!image?.isConnected) {
      return;
    }

    const tasks = [];

    if (attributeNeedsProxy(image, 'src', 'url')) {
      tasks.push(proxyURLAttribute(image, 'src'));
    }

    if (attributeNeedsProxy(image, 'srcset', 'srcset')) {
      tasks.push(proxySrcsetAttribute(image, 'srcset'));
    }

    for (const source of getPictureSources(image)) {
      if (attributeNeedsProxy(source, 'srcset', 'srcset')) {
        tasks.push(proxySrcsetAttribute(source, 'srcset'));
      }
    }

    if (tasks.length) {
      await Promise.allSettled(tasks);
    }
  }

  const imageObserver = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) {
            continue;
          }

          imageObserver.unobserve(entry.target);
          void proxyImageFamily(entry.target);
        }
      }, { rootMargin: CONFIG.IMAGE_ROOT_MARGIN })
    : null;

  function handleImage(image) {
    if (!image || image.tagName !== 'IMG') {
      return;
    }

    if (!imageHasProxyTarget(image)) {
      imageObserver?.unobserve(image);
      return;
    }

    if (imageObserver) {
      // 尺寸为 0 或祖先 display:none 的图片会等到真正可见时才触发。
      imageObserver.observe(image);
    } else {
      void proxyImageFamily(image);
    }
  }

  function handleSource(source) {
    if (!source || source.tagName !== 'SOURCE') {
      return;
    }

    const image = getPictureImage(source);

    if (image) {
      handleImage(image);
    }
  }

  // ============================================================
  // 链接
  // ============================================================

  function rewriteLink(anchor) {
    if (!anchor || anchor.tagName !== 'A' || !anchor.hasAttribute('href')) {
      return;
    }

    const rawHref = anchor.getAttribute('href');

    if (!rawHref) {
      return;
    }

    const url = parseURL(rawHref);

    if (!url || !shouldProxy(url)) {
      return;
    }

    const output = proxyURL(url);

    if (anchor.getAttribute('href') !== output) {
      anchor.setAttribute('href', output);
    }
  }

  // ============================================================
  // 元素清理
  // ============================================================

  function releaseElementAttribute(element, attributeName) {
    const state = getAttributeState(element, attributeName, false);

    if (!state) {
      return;
    }

    state.version++;
    state.pendingLogical = null;
    state.pendingPromise = null;

    if (!state.objectURLs.length) {
      return;
    }

    // 关键：不写回原始 URL。
    // 对脱离文档的 <img> 设置 src 依然会发起网络请求。
    scheduleRevocation(element, attributeName, state.objectURLs);
  }

  function cleanupElement(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    if (element.tagName === 'IMG') {
      imageObserver?.unobserve(element);
      releaseElementAttribute(element, 'src');
      releaseElementAttribute(element, 'srcset');
      return;
    }

    if (element.tagName === 'SOURCE') {
      releaseElementAttribute(element, 'srcset');
    }
  }

  // ============================================================
  // Shadow DOM
  // ============================================================

  const observedRoots = new WeakSet();
  const rootObservers = new WeakMap();
  const knownShadowRoots = new WeakMap();

  function registerShadowRoot(host, root) {
    if (!host || !root) {
      return;
    }

    knownShadowRoots.set(host, root);
    observeRoot(root);
  }

  function disconnectRoot(root) {
    if (!root || root === document) {
      return;
    }

    rootObservers.get(root)?.disconnect();
    rootObservers.delete(root);
    observedRoots.delete(root);
  }

  /**
   * 拦截 attachShadow。
   *
   * 脚本运行在 document-start，理论上能捕获此后创建的全部 Shadow Root，
   * 包括 closed 模式。
   *
   * 但 Firefox 的内容脚本与页面世界原型隔离，此补丁可能对页面调用无效，
   * 因此仍保留节流的全量遍历作为兜底。
   */
  function patchAttachShadow() {
    try {
      const prototype = Element.prototype;
      const original = prototype.attachShadow;

      if (typeof original !== 'function' || original.__githubProxyPatched) {
        return;
      }

      function patched(init) {
        const root = original.call(this, init);

        try {
          registerShadowRoot(this, root);
        } catch {
          // 不影响页面自身逻辑。
        }

        return root;
      }

      Object.defineProperty(patched, '__githubProxyPatched', { value: true });
      prototype.attachShadow = patched;
    } catch (error) {
      warn('attachShadow 拦截失败：', error);
    }
  }

  // ============================================================
  // 扫描
  // ============================================================

  function processElement(element) {
    switch (element.tagName) {
      case 'IMG':
        handleImage(element);
        break;

      case 'SOURCE':
        handleSource(element);
        break;

      case 'A':
        rewriteLink(element);
        break;

      default:
        break;
    }
  }

  const SCAN_SELECTOR = 'img, source, a[href]';

  /**
   * 只按选择器匹配，不做全量 * 遍历。
   */
  function scanElements(root) {
    if (!root) {
      return;
    }

    if (root.nodeType === Node.ELEMENT_NODE) {
      processElement(root);
    }

    root.querySelectorAll?.(SCAN_SELECTOR).forEach(processElement);
  }

  function discoverShadowRoot(element) {
    const root = element.shadowRoot || knownShadowRoots.get(element);

    if (root) {
      registerShadowRoot(element, root);
    }
  }

  /**
   * 全量 Shadow Root 遍历。
   * 代价是 O(节点数)，因此只在空闲扫描中按最小间隔执行。
   */
  function walkShadowRoots(root) {
    root.querySelectorAll?.('*').forEach(discoverShadowRoot);
  }

  function cleanupTree(root) {
    if (!root) {
      return;
    }

    if (
      root.nodeType === Node.DOCUMENT_FRAGMENT_NODE &&
      root !== document
    ) {
      disconnectRoot(root);
    }

    if (root.nodeType === Node.ELEMENT_NODE) {
      cleanupElement(root);

      const own = root.shadowRoot || knownShadowRoots.get(root);

      if (own) {
        cleanupTree(own);
      }
    }

    root.querySelectorAll?.('img, source').forEach(cleanupElement);
  }

  function scheduleTreeCleanup(node) {
    queueMicrotask(() => {
      // 同一任务内被移动再插入的节点不做清理。
      if (!node.isConnected) {
        cleanupTree(node);
      }
    });
  }

  // ============================================================
  // 空闲扫描
  // ============================================================

  let sweepScheduled = false;
  let lastShadowWalk = 0;

  function runSweep() {
    sweepScheduled = false;

    scanElements(document);

    const now = Date.now();

    if (now - lastShadowWalk >= CONFIG.SHADOW_WALK_MIN_INTERVAL_MS) {
      lastShadowWalk = now;
      walkShadowRoots(document);
    }
  }

  function scheduleSweep() {
    if (sweepScheduled) {
      return;
    }

    sweepScheduled = true;

    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(runSweep, { timeout: 1_000 });
    } else {
      setTimeout(runSweep, 300);
    }
  }

  // ============================================================
  // 事件委托
  // ============================================================

  // focusin 覆盖键盘 Tab + Enter 激活；
  // contextmenu 覆盖右键菜单；dragstart 覆盖拖拽下载。
  const DELEGATED_EVENTS = [
    'pointerover',
    'pointerdown',
    'focusin',
    'contextmenu',
    'dragstart',
    'click',
    'auxclick'
  ];

  function delegatedLinkHandler(event) {
    const path = typeof event.composedPath === 'function'
      ? event.composedPath()
      : [];

    let anchor = path.find(node => (
      node?.tagName === 'A' && node.hasAttribute?.('href')
    ));

    if (!anchor && event.target?.closest) {
      anchor = event.target.closest('a[href]');
    }

    if (anchor) {
      rewriteLink(anchor);
    }
  }

  // composedPath 已能穿透 Shadow DOM，所以只在 document 上注册一次。
  function installDelegatedEvents() {
    for (const eventName of DELEGATED_EVENTS) {
      document.addEventListener(eventName, delegatedLinkHandler, true);
    }
  }

  // ============================================================
  // MutationObserver
  // ============================================================

  function handleMutations(mutations) {
    let needsSweep = false;

    for (const mutation of mutations) {
      if (mutation.type === 'attributes') {
        const target = mutation.target;
        const name = mutation.attributeName;

        if (target.tagName === 'A' && name === 'href') {
          rewriteLink(target);
        } else if (
          target.tagName === 'IMG' &&
          (name === 'src' || name === 'srcset')
        ) {
          handleImage(target);
        } else if (target.tagName === 'SOURCE' && name === 'srcset') {
          handleSource(target);
        }

        continue;
      }

      if (mutation.type !== 'childList') {
        continue;
      }

      for (const node of mutation.addedNodes) {
        if (
          node.nodeType === Node.ELEMENT_NODE ||
          node.nodeType === Node.DOCUMENT_FRAGMENT_NODE
        ) {
          scanElements(node);
          needsSweep = true;
        }
      }

      for (const node of mutation.removedNodes) {
        if (
          node.nodeType === Node.ELEMENT_NODE ||
          node.nodeType === Node.DOCUMENT_FRAGMENT_NODE
        ) {
          scheduleTreeCleanup(node);
        }
      }
    }

    // Shadow Root 发现交给节流的空闲扫描，不在每次 mutation 里做全量遍历。
    if (needsSweep) {
      scheduleSweep();
    }
  }

  function observeRoot(root) {
    if (!root || observedRoots.has(root)) {
      return;
    }

    observedRoots.add(root);

    const observer = new MutationObserver(handleMutations);

    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href', 'src', 'srcset']
    });

    rootObservers.set(root, observer);
    scanElements(root);
  }

  // ============================================================
  // 初始化
  // ============================================================

  patchAttachShadow();
  installDelegatedEvents();
  observeRoot(document);

  // 提前预热探针，避免首批图片等待。
  void probeMaterializeMode();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleSweep, { once: true });
  } else {
    scheduleSweep();
  }

  // GitHub 的软导航事件，用于补扫 Turbo/pjax 局部替换后的内容。
  for (const eventName of [
    'turbo:load',
    'turbo:render',
    'pjax:end',
    'soft-nav:end',
    'popstate',
    'hashchange'
  ]) {
    window.addEventListener(eventName, scheduleSweep);
  }

  window.addEventListener('pagehide', event => {
    if (event.persisted) {
      // 进入 bfcache，Blob 仍需保持有效。
      return;
    }

    blobCache.clear();
    blobCacheBytes = 0;
    inflightRequests.clear();
  });
})();