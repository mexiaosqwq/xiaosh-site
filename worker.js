export default {
  async fetch(request) {
    return new Response(
      `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>xiaosh.xyz</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      min-height: 100vh;
      display: flex; align-items: center; justify-content: center;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: #fff;
    }
    h1 { font-size: clamp(2rem, 8vw, 4rem); text-align: center; }
    p { text-align: center; margin-top: 1rem; opacity: 0.85; font-size: 1.1rem; }
  </style>
</head>
<body>
  <div>
    <h1>xiaosh.xyz</h1>
    <p>网站搭建中...</p>
  </div>
</body>
</html>`,
      {
        headers: { "content-type": "text/html;charset=UTF-8" },
      }
    );
  },
};
