// ==UserScript==
// @name         GitHub 下载与图片代理
// @namespace    https://xiaosh.xyz/
// @version      5.1.0
// @description  自动代理 GitHub 下载链接和图片，blob 方式绕过 CSP 和 Content-Disposition
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
  const PROXY = 'https://github-proxy.xiaosh.xyz/?url=';
  const PROXY_HOST = new URL(PROXY).hostname;
  const MAX_CACHE = 200;

  // 所有 *.githubusercontent.com + codeload
  const IS_CDN = h => /(^|\.)githubusercontent\.com$|^codeload\.github\.com$/i.test(h);

  // github.com 上的下载路径
  const DL_PATH = /(?:releases\/(?:latest\/)?download|archive|zipball|tarball|files|assets|user-attachments\/files|user-attachments\/assets)\//;

  // 图片扩展名
  const IMG_EXT = /\.(?:png|jpe?g|gif|webp|svg|ico)(?:\?|$)/i;

  // ==================== 核心 ====================

  function shouldProxy(u) {
    if (!u || !u.protocol.startsWith('http') || u.hostname === PROXY_HOST) return false;
    if (IS_CDN(u.hostname)) return true;
    if (u.pathname.includes('/blob/') || u.pathname.includes('/tree/')) return false;
    return (u.hostname === 'github.com' || u.hostname === 'gist.github.com') &&
      (DL_PATH.test(u.pathname) || IMG_EXT.test(u.pathname));
  }

  function proxyURL(u) {
    return PROXY + encodeURIComponent(u.href);
  }

  function isImage(u) {
    return IMG_EXT.test(u.pathname);
  }

  // ==================== 直接访问 CDN 跳转 ====================
  if (IS_CDN(location.hostname)) {
    try {
      const u = new URL(location.href);
      if (shouldProxy(u)) location.replace(proxyURL(u));
    } catch {}
    return;
  }

  // ==================== 链接替换 ====================

  // <a> 下载链接（直接替换 href）
  function rewriteLink(el) {
    if (el.dataset.gh) return;
    const href = el.getAttribute('href');
    if (!href) return;
    try {
      const u = new URL(href, location.href);
      if (shouldProxy(u)) {
        el.href = proxyURL(u);
        el.dataset.gh = '1';
      }
    } catch {}
  }

  // <img> 图片链接（blob 方式绕过 Content-Disposition）
  const blobCache = new Map();

  function fetchBlob(url) {
    if (blobCache.has(url)) return blobCache.get(url);
    const p = new Promise(resolve => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: proxyURL(new URL(url)),
        responseType: 'blob',
        timeout: 15000,
        onload: res => resolve(res.status === 200 && res.response ? URL.createObjectURL(res.response) : null),
        onerror: () => resolve(null),
        ontimeout: () => resolve(null)
      });
    });
    if (blobCache.size >= MAX_CACHE) {
      const oldest = blobCache.keys().next().value;
      blobCache.get(oldest)?.then(u => { if (u) URL.revokeObjectURL(u); });
      blobCache.delete(oldest);
    }
    blobCache.set(url, p);
    return p;
  }

  async function rewriteImg(el) {
    if (el.dataset.gh) return;
    const src = el.getAttribute('src');
    if (!src || src.includes(PROXY_HOST)) return;
    try {
      const u = new URL(src, location.href);
      if (!shouldProxy(u)) return;
      el.dataset.gh = '1';
      const blobUrl = await fetchBlob(u.href);
      if (blobUrl) {
        el.src = blobUrl;
        el.removeAttribute('srcset');
        el.removeAttribute('loading');
      }
    } catch {}
  }

  // ==================== 扫描 ====================

  function scan(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.tagName === 'IMG') rewriteImg(node);
    else if (node.tagName === 'A') rewriteLink(node);

    if (node.querySelectorAll) {
      node.querySelectorAll('img').forEach(rewriteImg);
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

  // MutationObserver
  new MutationObserver(muts => {
    for (const m of muts) {
      if (m.type === 'attributes') {
        const t = m.target;
        if (t.tagName === 'IMG' && m.attributeName === 'src') rewriteImg(t);
        else if (t.tagName === 'A' && m.attributeName === 'href') rewriteLink(t);
      } else {
        m.addedNodes.forEach(n => { if (n.nodeType === 1) scan(n); });
      }
    }
  }).observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'href']
  });

  // 事件委托兜底
  document.addEventListener('pointerover', e => {
    const t = e.composedPath?.()[0];
    if (!t) return;
    if (t.tagName === 'IMG') rewriteImg(t);
    else if (t.tagName === 'A') rewriteLink(t);
  }, true);

  console.log('[GH Proxy] v5.1.0 已启用');
})();
