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

    // Disable cache for debugging
    let response = null;

    if (!response) {
      try {
        let upstream = await fetch(targetUrl, {
          redirect: 'manual',
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; xiaosh-gh-proxy/1.0)',
            'Accept': '*/*',
          },
        });

        // Manually follow redirects to preserve final response headers
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

        // Extract filename from URL for Content-Disposition
        const urlPath = new URL(targetUrl).pathname;
        const filename = urlPath.split('/').pop() || 'download';

        // Use plain object for headers to avoid Headers API issues
        const headers = {
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Cache-Control': 'no-store, private',
          'X-Proxy-Cache': 'MISS',
          'Access-Control-Allow-Origin': '*',
        };
        // Copy upstream headers except content-disposition
        upstream.headers.forEach((value, key) => {
          if (key.toLowerCase() !== 'content-disposition') {
            headers[key] = value;
          }
        });

        response = new Response(upstream.body, {
          status: upstream.status,
          headers,
        });
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
