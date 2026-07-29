const GITHUB_HOSTS = [
  'github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
  'codeload.github.com',
  'github-releases.githubusercontent.com',
  'github-cloud.s3.amazonaws.com',
];

const ALLOWED_PREFIXES = [
  '/releases/download/',
  '/archive/',
  '/raw/',
  '/codeload/',
];

const CACHE_TTL_FIXED = 86400;
const CACHE_TTL_DEFAULT = 3600;

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

    const isFixedVersion = /\/(releases\/download\/v[\d.]+|archive\/refs\/tags\/v[\d.]+)/.test(targetUrl);
    const cacheTtl = isFixedVersion ? CACHE_TTL_FIXED : CACHE_TTL_DEFAULT;

    const cacheKey = new Request(targetUrl);
    const cache = caches.default;
    let response = await cache.match(cacheKey);

    if (!response) {
      try {
        const upstream = await fetch(targetUrl, {
          redirect: 'follow',
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; xiaosh-gh-proxy/1.0)',
            'Accept': '*/*',
          },
        });

        if (upstream.status !== 200) {
          return new Response(upstream.body, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: upstream.headers,
          });
        }

        response = new Response(upstream.body, {
          status: upstream.status,
          headers: {
            ...Object.fromEntries(upstream.headers),
            'Cache-Control': `public, max-age=${cacheTtl}`,
            'X-Proxy-Cache': 'MISS',
            'Access-Control-Allow-Origin': '*',
          },
        });

        cache.put(cacheKey, response.clone());
      } catch (e) {
        return new Response(
          JSON.stringify({ error: 'Fetch failed', message: e.message }),
          { status: 502, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    response = new Response(response.body, response.headers);
    response.headers.set('X-Proxy-Cache', 'HIT');
    return response;
  },
};
