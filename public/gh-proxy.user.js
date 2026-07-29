// ==UserScript==
// @name         GitHub 下载代理
// @namespace    https://xiaosh.xyz/
// @version      1.7.0
// @description  自动代理 GitHub 下载链接、Release 附件及资源直链，提升下载速度
// @author       xiaosh
// @match        *://github.com/*
// @match        *://gist.github.com/*
// @match        *://raw.githubusercontent.com/*
// @match        *://codeload.github.com/*
// @match        *://objects.githubusercontent.com/*
// @match        *://gist.githubusercontent.com/*
// @match        *://media.githubusercontent.com/*
// @match        *://release-assets.githubusercontent.com/*
// @match        *://github-releases.githubusercontent.com/*
// @match        *://user-images.githubusercontent.com/*
// @match        *://private-user-images.githubusercontent.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const PROXY_BASE = 'https://github-proxy.xiaosh.xyz/?url=';
  const PROXY_HOST = new URL(PROXY_BASE).hostname;

  // GitHub 资源下载域名（直接代理）
  const DIRECT_HOSTS = new Set([
    'raw.githubusercontent.com',
    'codeload.github.com',
    'objects.githubusercontent.com',
    'gist.githubusercontent.com',
    'media.githubusercontent.com',
    'release-assets.githubusercontent.com',
    'github-releases.githubusercontent.com',
    'user-images.githubusercontent.com',
    'private-user-images.githubusercontent.com'
  ]);

  // github.com / gist.github.com 上的下载路径
  const DOWNLOAD_PATHS = [
    /^\/[^/]+\/[^/]+\/releases\/download\//,
    /^\/[^/]+\/[^/]+\/releases\/latest\/download\//,
    /^\/[^/]+\/[^/]+\/(?:archive|zipball|tarball)\//,
    /^\/[^/]+\/[^/]+\/(?:files|assets)\//,
    /^\/user-attachments\/(?:files|assets)\//
  ];

  function shouldProxy(url) {
    if (!url) return false;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (url.hostname === PROXY_HOST) return false;
    if (DIRECT_HOSTS.has(url.hostname)) return true;
    return (url.hostname === 'github.com' || url.hostname === 'gist.github.com') &&
      DOWNLOAD_PATHS.some(p => p.test(url.pathname));
  }

  // 直接访问 CDN 域名时自动跳转代理
  if (DIRECT_HOSTS.has(location.hostname)) {
    try {
      const url = new URL(location.href);
      if (shouldProxy(url)) {
        location.replace(PROXY_BASE + encodeURIComponent(url.href));
      }
    } catch { /* ignore */ }
    return;
  }

  // 穿透 Shadow DOM 获取 <a> 元素
  function getLink(event) {
    const path = event.composedPath?.() || [];
    for (const el of path) {
      if (el?.tagName === 'A' && el.hasAttribute('href')) return el;
    }
    return null;
  }

  function rewriteLink(event) {
    const link = getLink(event);
    if (!link || link.dataset.ghProxied) return;

    let url;
    try {
      url = new URL(link.href, location.href);
    } catch {
      return;
    }

    if (!shouldProxy(url)) return;

    link.dataset.ghProxied = '1';
    link.href = PROXY_BASE + encodeURIComponent(url.href);
  }

  // pointerdown 覆盖左键/中键/右键，click 兜底键盘 Enter
  document.addEventListener('pointerdown', rewriteLink, true);
  document.addEventListener('click', rewriteLink, true);
})();
