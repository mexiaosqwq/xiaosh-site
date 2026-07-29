// ==UserScript==
// @name         GitHub 下载代理加速 (精准重构版)
// @namespace    https://xiaosh.xyz/
// @version      1.2.0
// @description  事件委托高性能拦截 + 真实下载路径精准匹配 + 直链访问自动重定向。
// @author       xiaosh & DeepSeek
// @match        https://github.com/*
// @match        http://github.com/*
// @match        *://raw.githubusercontent.com/*
// @match        *://codeload.github.com/*
// @match        *://objects.githubusercontent.com/*
// @match        *://gist.githubusercontent.com/*
// @match        *://media.githubusercontent.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const PROXY_BASE = 'https://github-proxy.xiaosh.xyz/?url=';

  // 专用下载/资源子域名（点击这些域名下的资源，或直接访问这些域名，均走代理）
  const DIRECT_PROXY_HOSTS = new Set([
    'raw.githubusercontent.com',
    'codeload.github.com',
    'objects.githubusercontent.com',
    'gist.githubusercontent.com',
    'media.githubusercontent.com'
  ]);

  // 场景 1：如果用户直接在地址栏打开了 raw / codeload 等资源直链，立即自动重定向至代理
  if (DIRECT_PROXY_HOSTS.has(window.location.hostname)) {
    window.location.replace(PROXY_BASE + encodeURIComponent(window.location.href));
    return;
  }

  // 场景 2：在 github.com 主站上的链接动态拦截逻辑

  // github.com 主站上【严格限定】为下载/文件的路径正则（严禁包含 /blob/ 等页面查看路径）
  const GITHUB_PROXY_PATTERNS = [
    /\/releases\/download\//,          // Release 发布包
    /\/archive\//,                     // 源码打包 (zip / tar.gz)
    /\/raw\//,                         // Raw 原始文件直链
    /\/user-attachments\/files\//     // Issue/PR 中上传的日志/附件
  ];

  function shouldProxy(urlStr) {
    try {
      const u = new URL(urlStr);

      // 已是代理链接则跳过
      if (u.href.startsWith(PROXY_BASE)) return false;

      // 1. 指向专用资源域名的链接
      if (DIRECT_PROXY_HOSTS.has(u.hostname)) return true;

      // 2. github.com 主站上的特定下载路径
      if (u.hostname === 'github.com') {
        return GITHUB_PROXY_PATTERNS.some(pattern => pattern.test(u.pathname));
      }

      return false;
    } catch {
      return false;
    }
  }

  function getProxyUrl(originalUrl) {
    return PROXY_BASE + encodeURIComponent(originalUrl);
  }

  function handleAction(e) {
    const a = e.target.closest('a[href]');
    if (!a) return;

    // 读取原始 Href，防止重复拼接
    const originalHref = a.getAttribute('data-original-href') || a.href;

    if (shouldProxy(originalHref)) {
      if (!a.hasAttribute('data-original-href')) {
        a.setAttribute('data-original-href', originalHref);
      }
      a.href = getProxyUrl(originalHref);
    }
  }

  // 捕获阶段事件委托：涵盖点击、右键菜单、中键后台打开
  document.addEventListener('click', handleAction, true);
  document.addEventListener('contextmenu', handleAction, true);
  document.addEventListener('auxclick', handleAction, true);

  console.log('[GH Proxy] 高性能代理拦截 (v1.2.0) 已启用 → ' + PROXY_BASE);
})();
