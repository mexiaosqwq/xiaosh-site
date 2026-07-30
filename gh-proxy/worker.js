const CACHE_TTL_FIXED = 86400;  // 24h for versioned releases
const CACHE_TTL_DEFAULT = 3600; // 1h for others

const ALLOWED_PREFIXES = [
  '/releases/download/',
  '/archive/',
  '/raw/',
  '/codeload/',
];

function isAllowedUrl(targetUrl) {
  try {
    const u = new URL(targetUrl);
    const host = u.hostname;

    // 所有 *.githubusercontent.com 子域名 + codeload
    if (/(^|\.)githubusercontent\.com$|^codeload\.github\.com$/i.test(host)) {
      return true;
    }

    // github.com / gist.github.com 上的下载路径
    if (host === 'github.com' || host === 'gist.github.com') {
      return ALLOWED_PREFIXES.some(p => u.pathname.includes(p));
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * 从 URL 路径提取文件名，用于 Content-Disposition 兜底。
 * 处理 query string、多次重定向后路径变化等情况。
 */
function extractFilename(urlValue) {
  try {
    const u = new URL(urlValue);
    // pathname 去掉末尾 / 后取最后一段
    const seg = u.pathname.replace(/\/+$/, '').split('/').pop() || '';
    // 去掉 query / hash 残留，限制长度
    return seg.split('?')[0].split('#')[0].slice(0, 200) || 'download';
  } catch {
    return 'download';
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    let targetUrl = url.searchParams.get('url');

    if (!targetUrl) {
      const path = url.pathname;
      if (path.length > 1) {
        targetUrl = decodeURIComponent(path.slice(1));
        if (!targetUrl.startsWith('http')) {
          targetUrl = 'https://' + targetUrl;
        }
      }
    }

    if (!targetUrl) {
      return new Response(
        JSON.stringify({
          error: 'Missing url parameter',
          usage: 'https://github-proxy.xiaosh.xyz/?url=https://github.com/.../releases/download/.../file.zip',
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (!isAllowedUrl(targetUrl)) {
      return new Response(
        JSON.stringify({
          error: 'URL not allowed',
          allowedHosts: GITHUB_HOSTS,
        }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Check Worker cache first (use versioned cache key to avoid stale entries)
    const isFixedVersion = /\/(releases\/download\/v[\d.]+|archive\/refs\/tags\/v[\d.]+)/.test(targetUrl);
    const cacheTtl = isFixedVersion ? CACHE_TTL_FIXED : CACHE_TTL_DEFAULT;
    const cacheKey = new Request(targetUrl + '-v5');
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    if (cached) {
      // Return cached response with HIT marker
      const headers = new Headers(cached.headers);
      headers.set('X-Proxy-Cache', 'HIT');
      return new Response(cached.body, { status: 200, headers });
    }

    try {
      let upstream = await fetch(targetUrl, {
        redirect: 'manual',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; xiaosh-gh-proxy/1.0)',
          'Accept': '*/*',
        },
      });

      // Follow redirects manually, 记录最终 URL 用于提取文件名
      let redirectCount = 0;
      while (upstream.status >= 300 && upstream.status < 400 && redirectCount < 10) {
        const location = upstream.headers.get('location');
        if (!location) break;
        upstream = await fetch(location, {
          redirect: 'manual',
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; xiaosh-gh-proxy/1.0)',
            'Accept': '*/*',
          },
        });
        redirectCount++;
      }

      if (upstream.status !== 200) {
        // 非 200 透传，保留原始 headers（含可能的 Location）
        return new Response(upstream.body, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: upstream.headers,
        });
      }

      // ===== 构建响应头：以上游为基础，按需覆盖 =====
      const headers = new Headers(upstream.headers);

      // Content-Type：上游有就保留，没有才补默认值
      if (!headers.has('content-type')) {
        headers.set('Content-Type', 'application/octet-stream');
      }

      // Content-Disposition：优先保留上游的（GitHub CDN 会带正确的 filename）；
      // 上游没有才自己构造，使用最终 URL 路径提取文件名
      if (!headers.has('content-disposition')) {
        const finalUrl = targetUrl; // 手动跟随重定向后无法获取最终 URL，用原始 URL 近似
        const filename = extractFilename(finalUrl);
        headers.set('Content-Disposition', `attachment; filename="${filename}"`);
      }

      // 覆盖缓存策略
      headers.set('Cache-Control', `public, max-age=${cacheTtl}`);
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('X-Proxy-Cache', 'MISS');

      // 确保大文件下载体验：Content-Length / Accept-Ranges / ETag / Last-Modified
      // 已从 upstream.headers 透传，无需额外处理

      const response = new Response(upstream.body, {
        status: 200,
        headers,
      });

      // Store in Worker cache
      await cache.put(cacheKey, response.clone());
      return response;
    } catch (e) {
      return new Response(
        JSON.stringify({ error: 'Fetch failed', message: e.message }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      );
    }
  },
};
