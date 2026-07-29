// ==UserScript==
// @name         GitHub 下载与图片代理
// @namespace    https://xiaosh.xyz/
// @version      3.0.0
// @description  自动代理 GitHub 下载链接和图片，页面加载即替换，加速渲染
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

  // GitHub 资源域名
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
    if (!url || !url.protocol.startsWith('http') || url.hostname === PROXY_HOST) return false;
    if (DIRECT_HOSTS.has(url.hostname)) return true;
    return (url.hostname === 'github.com' || url.hostname === 'gist.github.com') &&
      DOWNLOAD_PATHS.some(p => p.test(url.pathname));
  }

  function getProxyURL(url) {
    return PROXY_BASE + encodeURIComponent(url.href);
  }

  // 直接访问 CDN 域名时自动跳转代理
  if (DIRECT_HOSTS.has(location.hostname)) {
    try {
      const url = new URL(location.href);
      if (shouldProxy(url)) {
        location.replace(getProxyURL(url));
      }
    } catch { /* ignore */ }
    return;
  }

  // --- 替换 <a> 下载链接 ---
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

  // --- 替换 <img> 图片链接 ---
  function rewriteImage(element) {
    if (element.dataset.ghProxied) return;
    const src = element.getAttribute('src');
    if (!src || src.startsWith('blob:') || src.includes(PROXY_HOST)) return;
    try {
      const url = new URL(src, location.href);
      if (shouldProxy(url)) {
        element.src = getProxyURL(url);
        element.dataset.ghProxied = '1';
        // 移除懒加载，立即加载
        if (element.hasAttribute('loading')) {
          element.removeAttribute('loading');
        }
      }
    } catch { /* ignore */ }
  }

  // --- 扫描并替换节点 ---
  function scanNode(node) {
    if (node.tagName === 'IMG') {
      rewriteImage(node);
    } else if (node.tagName === 'A') {
      rewriteLink(node);
    }
    // 处理 <picture> 内的 <source>
    if (node.tagName === 'PICTURE') {
      node.querySelectorAll('source').forEach(s => s.remove());
    }
    // 递归子节点
    if (node.querySelectorAll) {
      node.querySelectorAll('img').forEach(rewriteImage);
      node.querySelectorAll('a[href]').forEach(rewriteLink);
    }
    // 穿透 Shadow DOM
    if (node.shadowRoot) {
      scanNode(node.shadowRoot);
    }
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
        if (m.target.tagName === 'IMG' && m.attributeName === 'src') {
          rewriteImage(m.target);
        } else if (m.target.tagName === 'A' && m.attributeName === 'href') {
          rewriteLink(m.target);
        }
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

  // --- 预加载可视区域图片 ---
  if ('IntersectionObserver' in window) {
    const imgObserver = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const img = entry.target;
          imgObserver.unobserve(img);
          // 强制加载懒加载图片
          if (img.dataset.src && !img.src) {
            img.src = img.dataset.src;
          }
        }
      });
    }, { rootMargin: '200px' });

    // 扫描已有懒加载图片
    document.querySelectorAll('img[loading="lazy"], img[data-src]').forEach(img => {
      imgObserver.observe(img);
    });
  }

  console.log('[GH Proxy] v3.0.0 已启用，图片即时代理');
})();
