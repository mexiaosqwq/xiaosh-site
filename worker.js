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
