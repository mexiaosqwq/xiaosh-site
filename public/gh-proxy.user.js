// ==UserScript==
// @name         GitHub 下载与图片代理
// @namespace    https://xiaosh.xyz/
// @version      5.0.0
// @description  自动代理 GitHub 下载链接和图片，直接替换 URL 加速加载
// @author       xiaosh
// @match        *://github.com/*
// @match        *://gist.github.com/*
// @match        *://*.githubusercontent.com/*
// @match        *://codeload.github.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  // ==================== 配置 ====================
  const PROXY = 'https://github-proxy.xiaosh.xyz/?url=';
  const PROXY_HOST = new URL(PROXY).hostname;

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

  // ==================== 直接访问 CDN 跳转 ====================
  if (IS_CDN(location.hostname)) {
    try {
      const u = new URL(location.href);
      if (shouldProxy(u)) location.replace(proxyURL(u));
    } catch {}
    return;
  }

  // ==================== 链接替换 ====================

  // <a> 下载链接
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

  // <img> 图片链接（直接替换 src，不走 blob）
  function rewriteImg(el) {
    if (el.dataset.gh) return;
    const src = el.getAttribute('src');
    if (!src || src.includes(PROXY_HOST)) return;
    try {
      const u = new URL(src, location.href);
      if (!shouldProxy(u)) return;
      el.dataset.gh = '1';
      el.src = proxyURL(u);
      el.removeAttribute('srcset');
      el.removeAttribute('loading');
    } catch {}
  }

  // background-image CSS
  function rewriteBg(el) {
    if (el.dataset.ghBg) return;
    const bg = getComputedStyle(el).backgroundImage;
    const m = bg.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/);
    if (!m) return;
    try {
      const u = new URL(m[1], location.href);
      if (!shouldProxy(u)) return;
      el.dataset.ghBg = '1';
      el.style.backgroundImage = `url("${proxyURL(u)}")`;
    } catch {}
  }

  // ==================== 扫描 ====================

  function scan(node) {
    if (!node || node.nodeType !== 1) return;

    if (node.tagName === 'IMG') rewriteImg(node);
    else if (node.tagName === 'A') rewriteLink(node);
    else if (node.style?.backgroundImage?.includes('url(')) rewriteBg(node);

    // 批量处理子节点
    if (node.querySelectorAll) {
      node.querySelectorAll('img').forEach(rewriteImg);
      node.querySelectorAll('a[href]').forEach(rewriteLink);
      node.querySelectorAll('[style*="url("]').forEach(rewriteBg);
    }

    // Shadow DOM
    if (node.shadowRoot) scan(node.shadowRoot);
  }

  // 初始扫描
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => scan(document.body));
  } else {
    scan(document.body);
  }

  // MutationObserver（捕获动态内容）
  new MutationObserver(muts => {
    for (const m of muts) {
      if (m.type === 'attributes') {
        const t = m.target;
        if (t.tagName === 'IMG' && m.attributeName === 'src') rewriteImg(t);
        else if (t.tagName === 'A' && m.attributeName === 'href') rewriteLink(t);
        else if (m.attributeName === 'style') rewriteBg(t);
      } else {
        m.addedNodes.forEach(n => { if (n.nodeType === 1) scan(n); });
      }
    }
  }).observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'href', 'style']
  });

  // 事件委托兜底（处理 React 合成事件）
  document.addEventListener('pointerover', e => {
    const target = e.composedPath?.()[0];
    if (!target) return;
    if (target.tagName === 'IMG') rewriteImg(target);
    else if (target.tagName === 'A') rewriteLink(target);
    else if (target.style?.backgroundImage) rewriteBg(target);
  }, true);

  console.log('[GH Proxy] v5.0.0 已启用');
})();
