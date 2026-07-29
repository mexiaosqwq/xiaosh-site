const CACHE_TTL_FIXED = 86400;  // 24h for versioned releases
const CACHE_TTL_DEFAULT = 3600; // 1h for others

const GITHUB_HOSTS = [
  'github.com',
  'gist.github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
  'codeload.github.com',
  'github-releases.githubusercontent.com',
  'github-cloud.s3.amazonaws.com',
  'release-assets.githubusercontent.com',
  'gist.githubusercontent.com',
  'media.githubusercontent.com',
  'user-images.githubusercontent.com',
  'private-user-images.githubusercontent.com'
];

const ALLOWED_PREFIXES = [
  '/releases/download/',
  '/archive/',
  '/raw/',
  '/codeload/',
];

function isAllowedUrl(targetUrl) {
  try {
    const u = new URL(targetUrl);
    if (!GITHUB_HOSTS.includes(u.hostname)) return false;
    if (u.hostname === 'github.com') {
      return ALLOWED_PREFIXES.some(p => u.pathname.includes(p));
    }
    return true;
  } catch {
    return false;
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
    const cacheKey = new Request(targetUrl + '-v4');
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    if (cached) {
      // Return cached response with HIT marker
      const headers = {};
      cached.headers.forEach((value, key) => { headers[key] = value; });
      headers['X-Proxy-Cache'] = 'HIT';
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

      // Follow redirects manually
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
        return new Response(upstream.body, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: upstream.headers,
        });
      }

      // Extract filename from URL
      const urlPath = new URL(targetUrl).pathname;
      const filename = urlPath.split('/').pop() || 'download';

      // Build response with Content-Disposition
      const response = new Response(upstream.body, {
        status: 200,
        headers: {
          'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Cache-Control': `public, max-age=${cacheTtl}`,
          'Access-Control-Allow-Origin': '*',
          'X-Proxy-Cache': 'MISS',
        },
      });

      // Store in Worker cache
      cache.put(cacheKey, response.clone());
      return response;
    } catch (e) {
      return new Response(
        JSON.stringify({ error: 'Fetch failed', message: e.message }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      );
    }
  },
};
