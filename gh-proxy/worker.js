/**
 * GitHub 反向代理 Worker
 *
 * 设计原则：以上游响应为基底透传，只在必要时覆盖单个头，
 * 不重新构造 headers。
 */

const ALLOWED_HOSTS = [
  /^github\.com$/i,
  /^gist\.github\.com$/i,
  /^codeload\.github\.com$/i,
  /(^|\.)githubusercontent\.com$/i,
  /^api\.github\.com$/i,
  /^objects\.githubusercontent\.com$/i,
  /^release-assets\.githubusercontent\.com$/i,
];

// 需要原样透传给上游的请求头。
const FORWARD_REQUEST_HEADERS = [
  'range',
  'if-range',
  'if-none-match',
  'if-modified-since',
  'accept',
  'user-agent',
];

// 必须透传回客户端的响应头。
const PRESERVE_RESPONSE_HEADERS = [
  'content-type',
  'content-length',
  'content-disposition',
  'content-range',
  'content-encoding',
  'accept-ranges',
  'etag',
  'last-modified',
  'vary',
];

// 由 Worker 自己决定、不能让上游污染的头。
const STRIP_RESPONSE_HEADERS = [
  'set-cookie',
  'set-cookie2',
  'clear-site-data',
  'content-security-policy',
  'content-security-policy-report-only',
  'strict-transport-security',
  'public-key-pins',
  'x-frame-options',
  'report-to',
  'nel',
  'alt-svc',
  'server-timing',
  'cf-cache-status',
  'cf-ray',
];

const EXPOSED_HEADERS = [
  'Content-Type',
  'Content-Length',
  'Content-Disposition',
  'Content-Range',
  'Accept-Ranges',
  'ETag',
  'Last-Modified',
  'X-Proxy-Cache',
  'X-Proxy-Final-URL',
].join(', ');

// 扩展名 → MIME。仅用于上游类型明显错误时的补正。
const EXTENSION_MIME = {
  apng: 'image/apng',
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
};

// 上游给出这些类型时视为"没有有效类型"，允许按扩展名补正。
const VAGUE_MIME = new Set([
  '',
  'application/octet-stream',
  'binary/octet-stream',
  'text/plain',
  'text/plain; charset=utf-8',
  'application/unknown',
]);

// ============================================================
// 工具
// ============================================================

function isAllowedHost(hostname) {
  return ALLOWED_HOSTS.some(pattern => pattern.test(hostname));
}

/**
 * 解析目标 URL。
 *
 * 支持 ?url=<encoded> 与 ?url=<raw>；
 * 也支持路径式 /https://github.com/... 便于手工调试。
 */
function resolveTarget(request) {
  const requestURL = new URL(request.url);

  let raw = requestURL.searchParams.get('url');

  if (!raw) {
    // /https://... 形式。
    const path = requestURL.pathname.replace(/^\/+/, '');

    if (/^https?:\/{1,2}/i.test(path)) {
      raw = path.replace(/^(https?:)\/{1,2}/i, '$1//') + requestURL.search;
    }
  }

  if (!raw) {
    return { error: '缺少 url 参数', status: 400 };
  }

  // 客户端已 encodeURIComponent；这里对未编码的情况也宽容处理。
  let target;

  try {
    target = new URL(raw);
  } catch {
    try {
      target = new URL(decodeURIComponent(raw));
    } catch {
      return { error: '无法解析目标 URL', status: 400 };
    }
  }

  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return { error: '仅支持 http/https', status: 400 };
  }

  // 防止自我递归。
  if (target.hostname === requestURL.hostname) {
    return { error: '目标不能是代理自身', status: 400 };
  }

  if (!isAllowedHost(target.hostname)) {
    return { error: `不支持的目标域名：${target.hostname}`, status: 403 };
  }

  return { target };
}

/**
 * 解析 Content-Disposition 中的文件名。
 * filename* (RFC 5987) 优先级高于 filename。
 */
function parseDispositionFilename(value) {
  if (!value) {
    return null;
  }

  const extended = value.match(
    /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i
  );

  if (extended) {
    try {
      return decodeURIComponent(extended[2].trim());
    } catch {
      // 编码异常时回落到 filename。
    }
  }

  const plain = value.match(
    /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i
  );

  if (plain) {
    const name = (plain[1] || plain[2] || '').trim();
    return name || null;
  }

  return null;
}

/**
 * 从 URL 推导下载文件名。
 *
 * 对 tarball / zipball / legacy.* 这类
 * 末段不含真实文件名的路径做补全。
 */
function deriveFilenameFromURL(url) {
  const segments = url.pathname
    .split('/')
    .filter(Boolean)
    .map(segment => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });

  if (!segments.length) {
    return 'download';
  }

  const last = segments[segments.length - 1];
  const lower = url.pathname.toLowerCase();

  const repo = segments.length >= 2 ? segments[1] : 'download';
  const ref = last.replace(/[^\w.\-]+/g, '-') || 'archive';

  // /owner/repo/tarball/<ref> → repo-ref.tar.gz
  if (/\/tarball(\/|$)/.test(lower) && !/\.(?:tar\.gz|tgz)$/i.test(last)) {
    return `${repo}-${ref}.tar.gz`;
  }

  // /owner/repo/zipball/<ref> → repo-ref.zip
  if (/\/zipball(\/|$)/.test(lower) && !/\.zip$/i.test(last)) {
    return `${repo}-${ref}.zip`;
  }

  // codeload: /owner/repo/legacy.tar.gz/<ref>
  const legacy = lower.match(/\/legacy\.(tar\.gz|zip)\//);

  if (legacy) {
    return `${repo}-${ref}.${legacy[1]}`;
  }

  // /owner/repo/archive/<ref> 缺扩展名时补 .zip
  if (/\/archive(\/|$)/.test(lower) && !/\.[a-z0-9]{1,8}$/i.test(last)) {
    return `${repo}-${ref}.zip`;
  }

  return last || 'download';
}

/**
 * 构造 Content-Disposition。
 * 同时给出 filename 与 filename*，兼容非 ASCII 文件名。
 */
function buildContentDisposition(filename, disposition = 'attachment') {
  const asciiFallback = filename
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/["\\]/g, '_');

  const encoded = encodeURIComponent(filename);

  return `${disposition}; filename="${asciiFallback}"; ` +
    `filename*=UTF-8''${encoded}`;
}

function guessMimeFromPath(pathname) {
  const match = pathname.match(/\.([a-z0-9]+)$/i);

  if (!match) {
    return null;
  }

  return EXTENSION_MIME[match[1].toLowerCase()] || null;
}

function isImageRequest(headers) {
  const accept = (headers.get('accept') || '').toLowerCase();
  return accept.includes('image/');
}

function corsHeaders(request) {
  const origin = request.headers.get('origin');

  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers':
      request.headers.get('access-control-request-headers') ||
      'Range, If-Range, If-None-Match, If-Modified-Since',
    'Access-Control-Expose-Headers': EXPOSED_HEADERS,
    'Access-Control-Max-Age': '86400',
  };
}

function errorResponse(request, message, status) {
  return new Response(
    JSON.stringify({ error: message, status }, null, 2),
    {
      status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...corsHeaders(request),
      },
    }
  );
}

// ============================================================
// 主逻辑
// ============================================================

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request),
      });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return errorResponse(request, '仅支持 GET/HEAD', 405);
    }

    const resolved = resolveTarget(request);

    if (resolved.error) {
      return errorResponse(request, resolved.error, resolved.status);
    }

    const target = resolved.target;
    const hasRange = request.headers.has('range');

    // ------------------------------------------------------------
    // 缓存：Range、条件请求与 HEAD 一律跳过。
    // 缓存分片响应会导致后续完整请求拿到不完整数据。
    // ------------------------------------------------------------
    const cacheable =
      request.method === 'GET' &&
      !hasRange &&
      !request.headers.has('if-none-match') &&
      !request.headers.has('if-modified-since');

    const cache = caches.default;
    const cacheKey = new Request(
      `https://proxy.internal/v6/${encodeURIComponent(target.href)}`,
      { method: 'GET' }
    );

    if (cacheable) {
      const hit = await cache.match(cacheKey);

      if (hit) {
        const headers = new Headers(hit.headers);

        headers.set('X-Proxy-Cache', 'HIT');

        for (const [key, value] of Object.entries(corsHeaders(request))) {
          headers.set(key, value);
        }

        return new Response(hit.body, {
          status: hit.status,
          statusText: hit.statusText,
          headers,
        });
      }
    }

    // ------------------------------------------------------------
    // 请求上游
    // ------------------------------------------------------------
    const upstreamHeaders = new Headers();

    for (const name of FORWARD_REQUEST_HEADERS) {
      const value = request.headers.get(name);

      if (value) {
        upstreamHeaders.set(name, value);
      }
    }

    if (!upstreamHeaders.has('user-agent')) {
      upstreamHeaders.set('user-agent', 'github-proxy-worker');
    }

    // 请求未压缩内容，让 Content-Length 与实际传输字节保持一致。
    // Cloudflare 在自动解压时会剥离 Content-Encoding，
    // 若上游仍返回压缩内容则原 Content-Length 会失真。
    upstreamHeaders.set('accept-encoding', 'identity');

    let upstream;

    try {
      upstream = await fetch(target.href, {
        method: request.method,
        headers: upstreamHeaders,

        // 跟随 GitHub 的 302，最终响应来自实际存放资源的 CDN。
        redirect: 'follow',
      });
    } catch (error) {
      return errorResponse(
        request,
        `上游请求失败：${error?.message || error}`,
        502
      );
    }

    // ------------------------------------------------------------
    // 以上游响应为基底构造响应。
    //
    // 这一步是关键：new Response(body, upstream) 会继承
    // status、statusText 与全部 headers，
    // 因此 206 / 304 / Content-Length / Content-Range /
    // Accept-Ranges / ETag / Last-Modified 都不会丢。
    // ------------------------------------------------------------
    const noBody =
      request.method === 'HEAD' ||
      upstream.status === 204 ||
      upstream.status === 304;

    const response = new Response(
      noBody ? null : upstream.body,
      upstream
    );

    const headers = response.headers;

    for (const name of STRIP_RESPONSE_HEADERS) {
      headers.delete(name);
    }

    // 仅当上游声明了压缩、且属于会被运行时自动解压的文本类型时，
    // 才丢弃可能失真的 content-length。二进制下载保留上游长度，
    // 让浏览器能显示文件大小和下载进度。
    const encoding = (headers.get('content-encoding') || '').toLowerCase();
    const typeForLen = (headers.get('content-type') || '').toLowerCase();

    const isTextLike =
      typeForLen.startsWith('text/') ||
      typeForLen.includes('json') ||
      typeForLen.includes('xml') ||
      typeForLen.includes('javascript');

    if (encoding && encoding !== 'identity' && isTextLike) {
      headers.delete('content-length');
    }

    // ------------------------------------------------------------
    // Content-Type：仅在上游类型明显无意义时按扩展名补正
    // ------------------------------------------------------------
    const upstreamType = (headers.get('content-type') || '')
      .trim()
      .toLowerCase();

    if (VAGUE_MIME.has(upstreamType)) {
      const guessed = guessMimeFromPath(target.pathname);

      if (guessed) {
        headers.set('content-type', guessed);
      } else if (!upstreamType) {
        headers.set('content-type', 'application/octet-stream');
      }
    }

    // ------------------------------------------------------------
    // Content-Disposition
    //
    // 优先使用上游（CDN 给的文件名才是权威的）；
    // 仅在上游缺失时才自行推导。
    // ------------------------------------------------------------
    const upstreamDisposition = headers.get('content-disposition');
    const upstreamFilename = parseDispositionFilename(upstreamDisposition);
    const finalURL = new URL(upstream.url || target.href);

    if (upstreamFilename) {
      // 上游已有有效文件名，原样保留。
      // 若上游只给了 filename 而没有 filename*，补一个以兼容非 ASCII。
      if (
        upstreamDisposition &&
        !/filename\*\s*=/i.test(upstreamDisposition) &&
        /[^\x20-\x7E]/.test(upstreamFilename)
      ) {
        const type = /^\s*inline/i.test(upstreamDisposition)
          ? 'inline'
          : 'attachment';

        headers.set(
          'content-disposition',
          buildContentDisposition(upstreamFilename, type)
        );
      }
    } else {
      const contentType = (headers.get('content-type') || '').toLowerCase();

      // 图片走内联显示，不要触发下载。
      // 判定依据：Accept 头带 image/ 或最终类型是 image/。
      const inlineImage =
        contentType.startsWith('image/') ||
        isImageRequest(request.headers);

      if (!inlineImage) {
        // 优先用重定向后的最终 URL 推导，
        // 因为 CDN 路径通常包含真实资产名。
        const filename =
          deriveFilenameFromURL(finalURL) ||
          deriveFilenameFromURL(target);

        headers.set(
          'content-disposition',
          buildContentDisposition(filename, 'attachment')
        );
      } else if (upstreamDisposition) {
        // 图片场景移除上游可能带的 attachment。
        headers.delete('content-disposition');
      }
    }

    // ------------------------------------------------------------
    // 断点续传能力声明
    // ------------------------------------------------------------
    if (
      !headers.has('accept-ranges') &&
      upstream.status === 200 &&
      headers.has('content-length')
    ) {
      // 上游未声明但实际支持时，显式告知客户端。
      // 若上游其实不支持，客户端的 Range 请求会拿到 200 全量响应，
      // 浏览器会退回普通下载，不会损坏文件。
      headers.set('accept-ranges', 'bytes');
    }

    // ------------------------------------------------------------
    // 缓存策略
    // ------------------------------------------------------------
    if (!headers.has('cache-control')) {
      const isImmutable =
        /\/releases\/download\//i.test(finalURL.pathname) ||
        /\/[0-9a-f]{40}\//i.test(finalURL.pathname);

      headers.set(
        'cache-control',
        isImmutable
          ? 'public, max-age=31536000, immutable'
          : 'public, max-age=600'
      );
    }

    for (const [key, value] of Object.entries(corsHeaders(request))) {
      headers.set(key, value);
    }

    headers.set('X-Proxy-Cache', cacheable ? 'MISS' : 'BYPASS');
    headers.set('X-Proxy-Final-URL', finalURL.href);

    // ------------------------------------------------------------
    // 写入缓存
    // ------------------------------------------------------------
    if (cacheable && upstream.status === 200 && !noBody) {
      const contentLength = Number(headers.get('content-length') || 0);

      // 超大文件不进 Cache API，避免边缘缓存上限问题。
      if (contentLength > 0 && contentLength <= 128 * 1024 * 1024) {
        ctx.waitUntil(
          cache.put(cacheKey, response.clone()).catch(() => {
            // 缓存写入失败不影响本次响应。
          })
        );
      }
    }

    return response;
  },
};
