// ==UserScript==
// @name         GitHub 下载与图片代理
// @namespace    https://xiaosh.xyz/
// @version      4.0.0
// @description  自动代理 GitHub 下载链接和图片，绕过 CSP 限制，6 并发控制
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

  // ==================== 配置 ====================
  const PROXY_BASE = 'https://github-proxy.xiaosh.xyz/?url=';
  const PROXY_HOST = new URL(PROXY_BASE).hostname;
  const MAX_CONCURRENT = 6; // 匹配 Cloudflare Workers 并发限制
  const MAX_CACHE_SIZE = 200; // blob 缓存上限

  // GitHub CDN 域名（所有 *.githubusercontent.com + codeload）
  const IS_CDN_HOST = host => /(^|\.)githubusercontent\.com$|^codeload\.github\.com$/i.test(host);

  // github.com 上的下载路径
  const DOWNLOAD_PATHS = [
    /^\/[^/]+\/[^/]+\/releases\/download\//,
    /^\/[^/]+\/[^/]+\/releases\/latest\/download\//,
    /^\/[^/]+\/[^/]+\/(?:archive|zipball|tarball)\//,
    /^\/[^/]+\/[^/]+\/(?:files|assets)\//,
    /^\/user-attachments\/(?:files|assets)\//
  ];

  // 图片扩展名
  const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|svg|ico)(?:\?.*)?$/i;

  // ==================== 核心函数 ====================

  // 判断 URL 是否需要代理
  function shouldProxy(url) {
    if (!url || !url.protocol.startsWith('http') || url.hostname === PROXY_HOST) return false;
    if (IS_CDN_HOST(url.hostname)) return true;
    // 排除查看页面
    if (url.pathname.includes('/blob/') || url.pathname.includes('/tree/')) return false;
    // github.com / gist.github.com 上的下载和图片
    return (url.hostname === 'github.com' || url.hostname === 'gist.github.com') &&
      (DOWNLOAD_PATHS.some(p => p.test(url.pathname)) || IMAGE_EXT.test(url.pathname));
  }

  function toProxyURL(url) {
    return PROXY_BASE + encodeURIComponent(url.href);
  }

  // ==================== 直接访问 CDN 时自动跳转 ====================
  if (IS_CDN_HOST(location.hostname)) {
    try {
      const url = new URL(location.href);
      if (shouldProxy(url)) location.replace(toProxyURL(url));
    } catch { /* ignore */ }
    return;
  }

  // ==================== 模块 A: 下载链接替换 ====================
  function rewriteLink(el) {
    if (el.dataset.ghProxied) return;
    const href = el.getAttribute('href');
    if (!href) return;
    try {
      const url = new URL(href, location.href);
      if (shouldProxy(url)) {
        el.href = toProxyURL(url);
        el.dataset.ghProxied = '1';
      }
    } catch { /* ignore */ }
  }

  // ==================== 模块 B: 图片代理（Blob + 并发队列） ====================

  // 并发控制队列
  class Queue {
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
        fn().then(resolve).catch(reject).finally(() => { this.active--; this.next(); });
      }
    }
  }

  const imgQueue = new Queue(MAX_CONCURRENT);
  const blobCache = new Map();
  const processedImgs = new WeakSet();

  function fetchBlob(urlStr) {
    if (blobCache.has(urlStr)) return blobCache.get(urlStr);

    const promise = imgQueue.add(() => new Promise(resolve => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: toProxyURL(new URL(urlStr)),
        responseType: 'blob',
        timeout: 15000,
        onload: res => resolve(res.status === 200 && res.response ? URL.createObjectURL(res.response) : null),
        onerror: () => resolve(null),
        ontimeout: () => resolve(null)
      });
    }));

    // LRU 淘汰
    if (blobCache.size >= MAX_CACHE_SIZE) {
      const oldest = blobCache.keys().next().value;
      blobCache.get(oldest)?.then(url => { if (url) URL.revokeObjectURL(url); });
      blobCache.delete(oldest);
    }

    blobCache.set(urlStr, promise);
    return promise;
  }

  async function rewriteImage(el) {
    if (processedImgs.has(el)) return;

    // 清理 <picture> 内的 <source>
    if (el.parentElement?.tagName === 'PICTURE') {
      el.parentElement.querySelectorAll('source').forEach(s => s.remove());
    }

    const src = el.getAttribute('src');
    if (!src || src.startsWith('blob:')) return;

    try {
      const url = new URL(src, location.href);
      if (!shouldProxy(url)) return;

      processedImgs.add(el);
      el.dataset.ghProxied = '1'; // 标记已处理，让定期扫描跳过
      const blobUrl = await fetchBlob(url.href);
      if (blobUrl) {
        el.src = blobUrl;
        el.removeAttribute('srcset');
        el.removeAttribute('loading');
      }
    } catch { /* ignore */ }
  }

  // ==================== 模块 C: DOM 扫描 ====================

  function scan(node) {
    if (!node) return;
    if (node.tagName === 'IMG') rewriteImage(node);
    else if (node.tagName === 'A') rewriteLink(node);

    if (node.querySelectorAll) {
      node.querySelectorAll('img').forEach(rewriteImage);
      node.querySelectorAll('a[href]').forEach(rewriteLink);
    }
    if (node.shadowRoot) scan(node.shadowRoot);
  }

  // 初始扫描
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => scan(document.body));
  } else {
    scan(document.body);
  }

  // 监听动态内容
  new MutationObserver(mutations => {
    for (const m of mutations) {
      if (m.type === 'attributes') {
        if (m.target.tagName === 'IMG' && m.attributeName === 'src') rewriteImage(m.target);
        else if (m.target.tagName === 'A' && m.attributeName === 'href') rewriteLink(m.target);
      } else {
        m.addedNodes.forEach(node => { if (node.nodeType === 1) scan(node); });
      }
    }
  }).observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'href']
  });

  // 事件委托兜底
  ['pointerover', 'pointerdown', 'click'].forEach(type => {
    document.addEventListener(type, e => {
      const a = e.composedPath?.().find(el => el?.tagName === 'A' && el.hasAttribute?.('href'));
      if (a) rewriteLink(a);
    }, true);
  });

  // 定期扫描兜底（捕获 JS 动态插入的图片）
  setInterval(() => {
    document.querySelectorAll('img:not([data-gh-proxied])').forEach(rewriteImage);
  }, 2000);

  console.log('[GH Proxy] v4.0.0 已启用');
})();
