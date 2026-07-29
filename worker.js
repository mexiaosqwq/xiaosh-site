// ===== GitHub Proxy Config =====
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

const CACHE_TTL_FIXED = 86400;  // 24h for versioned releases
const CACHE_TTL_DEFAULT = 3600; // 1h for others

function isAllowedUrl(targetUrl) {
  try {
    const u = new URL(targetUrl);
    if (!GITHUB_HOSTS.includes(u.hostname)) return false;
    if (u.hostname === 'github.com') {
      return ALLOWED_PREFIXES.some(p => u.pathname.startsWith(p));
    }
    return true;
  } catch {
    return false;
  }
}

async function handleGitHubProxy(request, env) {
  const url = new URL(request.url);

  // Support two call styles:
  // 1. ?url=<encoded>  (Tampermonkey-friendly)
  // 2. /<original-path> (direct browser access)
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
        message: 'Only GitHub download URLs are permitted',
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

      // Only cache successful 200 responses; pass through errors uncached
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
          'X-Proxy-Target': targetUrl,
          'Access-Control-Allow-Origin': '*',
        },
      });

      // Fire-and-forget cache write (don't block response)
      cache.put(cacheKey, response.clone());
    } catch (e) {
      return new Response(
        JSON.stringify({
          error: 'Fetch failed',
          message: e.message,
        }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  // Cache hit: add marker header
  response = new Response(response.body, response.headers);
  response.headers.set('X-Proxy-Cache', 'HIT');

  return response;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    // ===== API: List images =====
    if (path === '/api/images' && method === 'GET') {
      try {
        const list = await env.IMAGE_BUCKET.list();
        const files = list.objects
          .map(o => ({
            name: o.key,
            uploaded: o.uploaded instanceof Date ? o.uploaded.toISOString() : null,
          }))
          .sort((a, b) => new Date(b.uploaded || 0) - new Date(a.uploaded || 0));
        return new Response(JSON.stringify(files), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }
    }

    // ===== API: Upload image =====
    if (path === '/api/upload' && method === 'POST') {
      try {
        const formData = await request.formData();
        const file = formData.get('file');
        if (!file) {
          return new Response(JSON.stringify({ error: 'No file' }), {
            status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
          });
        }
        if (!file.type.startsWith('image/')) {
          return new Response(JSON.stringify({ error: 'Not an image' }), {
            status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
          });
        }

        let name = file.name.replace(/[/\\]/g, '_');

        const existing = await env.IMAGE_BUCKET.get(name);
        if (existing) {
          const dot = name.lastIndexOf('.');
          if (dot > 0) {
            name = name.slice(0, dot) + '_' + Date.now() + name.slice(dot);
          } else {
            name = name + '_' + Date.now();
          }
        }

        await env.IMAGE_BUCKET.put(name, await file.arrayBuffer(), {
          httpMetadata: { contentType: file.type },
        });

        return new Response(JSON.stringify({ url: '/image/' + encodeURIComponent(name), name }), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }
    }

    // ===== API: Delete image =====
    if (path === '/api/images' && method === 'DELETE') {
      try {
        const name = url.searchParams.get('name');
        if (!name) {
          return new Response(JSON.stringify({ error: 'Missing name' }), {
            status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
          });
        }
        await env.IMAGE_BUCKET.delete(name);
        return new Response(JSON.stringify({ success: true }), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }
    }

    // ===== API: Rename image =====
    if (path === '/api/images/rename' && method === 'POST') {
      try {
        const { oldName, newName } = await request.json();
        if (!oldName || !newName) {
          return new Response(JSON.stringify({ error: 'Missing oldName or newName' }), {
            status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
          });
        }
        if (newName.includes('/') || newName.includes('\\')) {
          return new Response(JSON.stringify({ error: 'Invalid name' }), {
            status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
          });
        }

        const object = await env.IMAGE_BUCKET.get(oldName);
        if (!object) {
          return new Response(JSON.stringify({ error: 'Image not found' }), {
            status: 404, headers: { ...cors, 'Content-Type': 'application/json' },
          });
        }

        const existing = await env.IMAGE_BUCKET.get(newName);
        if (existing) {
          return new Response(JSON.stringify({ error: 'Name already exists' }), {
            status: 409, headers: { ...cors, 'Content-Type': 'application/json' },
          });
        }

        await env.IMAGE_BUCKET.put(newName, await object.arrayBuffer(), {
          httpMetadata: object.httpMetadata,
        });
        await env.IMAGE_BUCKET.delete(oldName);

        return new Response(JSON.stringify({ success: true, name: newName }), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }
    }

    // ===== GitHub proxy: ?url= or /<path> =====
    if (method === 'GET' && (path.length > 1 || url.searchParams.has('url'))) {
      return handleGitHubProxy(request, env);
    }

    // ===== Serve images from R2 =====
    if (path.startsWith('/image/') && method === 'GET') {
      const key = decodeURIComponent(path.slice(7));
      if (key) {
        const object = await env.IMAGE_BUCKET.get(key);
        if (object) {
          return new Response(object.body, {
            headers: {
              'Content-Type': object.httpMetadata?.contentType || 'image/png',
              'Cache-Control': 'public, max-age=31536000',
              'Access-Control-Allow-Origin': '*',
            },
          });
        }
      }
    }

    // ===== Fallback: static assets =====
    return env.ASSETS.fetch(request);
  },
};
