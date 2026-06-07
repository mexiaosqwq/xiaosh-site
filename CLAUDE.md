# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

xiaosh.xyz 个人网站，基于 Cloudflare Workers + 静态资源托管。Worker 做域名路由，HTML 页面放在 `public/` 独立维护。

## 架构

```
请求 → Worker (worker.js) → env.ASSETS → public/index.html 或 public/2048.html
```

- **worker.js**: 3 行路由，根据 hostname 选择页面（`2048.*` → 2048 游戏，其余 → 主页）
- **public/**: 所有静态页面，Worker 不内嵌 HTML
- **wrangler.toml**: `[assets]` 配置使 `public/` 目录作为静态资源被 Worker 的 `env.ASSETS` 访问
- **Worker 名称**: `proud-sun-003e`（Cloudflare Dashboard 中的名称，wrangler.toml 的 `name` 必须与之匹配）

## 部署

**本地无法运行 wrangler**（Android ARM64 不支持 workerd 运行时），所有部署通过 CI/CD：

- `git push main` → GitHub Actions 触发 `cloudflare/wrangler-action@v3` → `wrangler deploy`
- 需要 GitHub Secret: `CLOUDFLARE_API_TOKEN`（已配置）
- 部署命令：`wrangler deploy`（自动携带 public/ 静态资源，由 wrangler.toml 的 `[assets]` 声明）

## 域名

- `xiaosh.xyz` / `www.xiaosh.xyz` → 主页
- `2048.xiaosh.xyz` → 2048 游戏
- 自定义域名在 Cloudflare Dashboard → Worker → 域和路由 中管理

## 添加新页面

1. 在 `public/` 下创建 HTML 文件
2. 在 `worker.js` 添加路由规则
3. `git push` 即可上线
