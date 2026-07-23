# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

xiaosh.xyz 个人网站，基于 Cloudflare Workers + 静态资源托管 + R2 对象存储。

## 架构

```
请求 → Worker (worker.js)
  ├─ /api/* → API 处理（R2 操作）
  ├─ /image/xxx.png → 从 R2 读取图片，没有则回退到静态资源
  └─ 其他 → env.ASSETS → public/ 下对应路径的静态文件
```

- **worker.js**: 处理 API 请求（R2 图片上传/列表/删除/服务），其余回退到 `env.ASSETS` 静态资源
- **public/**: 所有静态页面，Worker 不内嵌 HTML
- **wrangler.toml**: `[assets]` 配置使 `public/` 目录作为静态资源被 Worker 的 `env.ASSETS` 访问；`[[r2_buckets]]` 绑定 `IMAGE_BUCKET` 到 R2 桶 `xiaosh-image-bed`；`[observability]` 已启用
- **Worker 名称**: `proud-sun-003e`（Cloudflare Dashboard 中的名称，wrangler.toml 的 `name` 必须与之匹配）
- **package.json**: `npm run deploy` → `wrangler deploy`，`npm run dev` → `wrangler dev`

## 部署

**本地无法运行 wrangler**（Android ARM64 不支持 workerd 运行时），所有部署通过 CI/CD：

- `git push main` → GitHub Actions 触发 `cloudflare/wrangler-action@v3` → `wrangler deploy`
- 支持通过 GitHub UI 手动触发（`workflow_dispatch`）

## 域名

- `xiaosh.xyz` / `www.xiaosh.xyz` → 主页
- 自定义域名在 Cloudflare Dashboard → Worker → 域和路由 中管理

## 添加新页面

1. 在 `public/` 下创建 HTML 文件（如 `public/xxx/index.html`）
2. 访问 `https://xiaosh.xyz/xxx/` 即可直接访问
3. `git push` 即可上线

## 图床 API

| 方法 | 路径 | 功能 |
|------|------|------|
| `GET` | `/api/images` | 列出 R2 中所有图片 |
| `POST` | `/api/upload` | 上传图片（multipart/form-data, field: file） |
| `DELETE` | `/api/images?name=xxx` | 删除图片 |

R2 桶名: `xiaosh-image-bed`（需在 Cloudflare Dashboard 创建）
