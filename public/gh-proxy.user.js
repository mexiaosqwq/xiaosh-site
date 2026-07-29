// ==UserScript==
// @name         GitHub 下载与图片代理
// @namespace    https://xiaosh.xyz/
// @version      3.2.0
// @description  自动代理 GitHub 下载链接和图片，打破 CSP 限制，支持内存缓存与 6 并发控制
// @author       xiaosh
// @match        *://github.com/*
// @match        *://gist.github.com/*
// @match        *://*.githubusercontent.com/*
// @match        *://codeload.github.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @connect      github-proxy.xiaosh.xyz
// @connect      *
// ==/UserScript==

(() => {
  'use strict';

  const PROXY_BASE = 'https://github-proxy.xiaosh.xyz/?url=';
  const PROXY_HOST = new URL(PROXY_BASE).hostname;

  // GitHub 资源域名（自动包含所有 githubusercontent.com 子域名）
  const IS_DIRECT_HOST = host => /(^|\.)githubusercontent\.com$|^codeload\.github\.com$/i.test(host);

  // github.com / gist.github.com 上的下载路径
  const DOWNLOAD_PATHS = [
    /^\/[^/]+\/[^/]+\/releases\/download\//,
    /^\/[^/]+\/[^/]+\/releases\/latest\/download\//,
    /^\/[^/]+\/[^/]+\/(?:archive|zipball|tarball)\//,
    /^\/[^/]+\/[^/]+\/(?:files|assets)\//,
    /^\/user-attachments\/(?:files|assets)\//
  ];

  // 图片扩展名（用于判断 github.com 上的图片链接）
  const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|svg|ico)(?:\?.*)?$/i;

  function shouldProxy(url) {
    if (!url || !url.protocol.startsWith('http') || url.hostname === PROXY_HOST) return false;

    // CDN 域名直接代理
    if (IS_DIRECT_HOST(url.hostname)) return true;

    // 排除 /blob/ 和 /tree/ 等查看页面
    if (url.pathname.includes('/blob/') || url.pathname.includes('/tree/')) return false;

    // github.com / gist.github.com 上的下载和图片路径
    return (url.hostname === 'github.com' || url.hostname === 'gist.github.com') &&
      (DOWNLOAD_PATHS.some(p => p.test(url.pathname)) || IMAGE_EXT.test(url.pathname));
  }

  function getProxyURL(url) {
    return PROXY_BASE + encodeURIComponent(url.href);
  }

  // 直接访问 CDN 域名时自动重定向
  if (IS_DIRECT_HOST(location.hostname)) {
    try {
      const url = new URL(location.href);
      if (shouldProxy(url)) location.replace(getProxyURL(url));
    } catch { /* ignore */ }
    return;
  }

  // --- 模块 A: 替换 <a> 下载链接 ---
  function rewriteLink(element) {
    if (element.dataset.ghProxied) return;
    const href = element.getAttribute('href');
    if (!href) return;
    try {
      const url = new URL(href, location.href);
      if (shouldProxy(url)) {
        element.href = getProxyURL(url);
        element.dataset.ghProxied = '1';
      }
    } catch { /* ignore */ }
  }

  // --- 模块 B: 6 并发队列与 Blob 缓存 ---
  class ConcurrencyQueue {
    constructor(maxConcurrent = 6) {
      this.max = maxConcurrent;
      this.active = 0;
      this.queue = [];
    }
    add(fn) {
      return new Promise((resolve, reject) => {
        this.queue.push({ fn, resolve, reject });
        this.next();
      });
    }
    next() {
      while (this.active < this.max && this.queue.length > 0) {
        const { fn, resolve, reject } = this.queue.shift();
        this.active++;
        fn().then(resolve).catch(reject).finally(() => {
          this.active--;
          this.next();
        });
      }
    }
  }

  const reqQueue = new ConcurrencyQueue(6);
  const blobCache = new Map();
  const MAX_CACHE_SIZE = 200; // 限制缓存数量防止内存泄漏
  const processedImgs = new WeakSet();

  function fetchImageBlob(targetUrlStr) {
    if (blobCache.has(targetUrlStr)) return blobCache.get(targetUrlStr);

    const promise = reqQueue.add(() => new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: getProxyURL(new URL(targetUrlStr)),
        responseType: 'blob',
        timeout: 15000,
        onload: (res) => {
          if (res.status === 200 && res.response) {
            resolve(URL.createObjectURL(res.response));
          } else {
            resolve(null);
          }
        },
        onerror: () => resolve(null),
        ontimeout: () => resolve(null)
      });
    }));

    // 限制缓存大小，淘汰最旧的条目
    if (blobCache.size >= MAX_CACHE_SIZE) {
      const firstKey = blobCache.keys().next().value;
      const oldBlob = blobCache.get(firstKey);
      if (oldBlob) {
        oldBlob.then(url => { if (url) URL.revokeObjectURL(url); }).catch(() => {});
      }
      blobCache.delete(firstKey);
    }

    blobCache.set(targetUrlStr, promise);
    return promise;
  }

  // --- 模块 C: 替换 <img> 图片链接（使用 Blob 绕过 CSP） ---
  async function rewriteImage(element) {
    if (processedImgs.has(element)) return;

    // 移除 <picture> 中的 <source>，防止干扰
    if (element.parentElement?.tagName === 'PICTURE') {
      element.parentElement.querySelectorAll('source').forEach(s => s.remove());
    }

    const src = element.getAttribute('src');
    if (!src || src.startsWith('blob:')) return;

    try {
      const url = new URL(src, location.href);
      if (!shouldProxy(url)) return;

      processedImgs.add(element);

      const blobUrl = await fetchImageBlob(url.href);
      if (blobUrl) {
        element.src = blobUrl;
        if (element.hasAttribute('srcset')) element.removeAttribute('srcset');
        if (element.hasAttribute('loading')) element.removeAttribute('loading');
      }
    } catch { /* ignore */ }
  }

  // --- 立即代理所有图片（不走 IntersectionObserver） ---
  function handleImg(img) {
    if (processedImgs.has(img)) return;
    const src = img.getAttribute('src');
    if (!src || src.startsWith('blob:')) return;
    try {
      const url = new URL(src, location.href);
      if (shouldProxy(url)) {
        rewriteImage(img); // 立即代理，不等滚动
      }
    } catch { /* ignore */ }
  }

  // --- 扫描与 Shadow DOM 穿透 ---
  function scanNode(node) {
    if (!node) return;
    if (node.tagName === 'IMG') handleImg(node);
    else if (node.tagName === 'A') rewriteLink(node);

    if (node.querySelectorAll) {
      node.querySelectorAll('img').forEach(handleImg);
      node.querySelectorAll('a[href]').forEach(rewriteLink);
    }
    if (node.shadowRoot) scanNode(node.shadowRoot);
  }

  // --- 初始扫描 ---
  function initScan() {
    scanNode(document.body || document.documentElement);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initScan);
  } else {
    initScan();
  }

  // --- MutationObserver 监听动态内容 ---
  const observer = new MutationObserver(mutations => {
    for (const m of mutations) {
      if (m.type === 'attributes') {
        if (m.target.tagName === 'IMG' && m.attributeName === 'src') handleImg(m.target);
        else if (m.target.tagName === 'A' && m.attributeName === 'href') rewriteLink(m.target);
      } else {
        m.addedNodes.forEach(node => {
          if (node.nodeType === 1) scanNode(node);
        });
      }
    }
  });

  observer.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'href']
  });

  // 事件委托兜底 <a> 链接重写
  ['pointerover', 'pointerdown', 'click'].forEach(type => {
    document.addEventListener(type, e => {
      const path = e.composedPath?.() || [];
      const a = path.find(el => el?.tagName === 'A' && el.hasAttribute?.('href'));
      if (a) rewriteLink(a);
    }, true);
  });

  console.log('[GH Proxy] v3.2.0 已启用');
})();
