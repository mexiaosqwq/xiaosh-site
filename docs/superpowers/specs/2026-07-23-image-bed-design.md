# 表情包图床页面设计

## 概述
在 xiaosh.xyz 上搭建一个简洁的图床页面，展示 `public/image/` 目录下的图片，支持点击查看大图和复制直链。新图片通过 git push 自动更新。

## 访问路径
`https://xiaosh.xyz/image/`

## 方案：构建时自动生成图片清单

### 流程
```
git push → Actions checkout → 生成 images.json → wrangler deploy → 上线
                                          ↑                          ↑
                                   自动扫描目录                    HTML 读取 JSON 渲染
```

### 涉及文件
| 文件 | 操作 |
|------|------|
| `public/表情包/index.html` | 新建 — 图床页面 |
| `.github/workflows/deploy.yml` | 修改 — 增加 manifest 生成步骤 |
| `worker.js` | 无需改动 |
| `wrangler.toml` | 无需改动 |

### 构建步骤
在 GitHub Actions 中使用 Node.js 一行命令扫描 `public/image/` 目录下的图片文件，生成 `images.json`。

## 页面设计

### 视觉风格
- 简洁纯粹，白/浅色背景，图片为主体
- 背景色: `#f5f3f0`（极浅暖灰）
- 字体: Inter

### 布局
- **顶部**: 标题「📦 表情包图床」+ 图片总数 + 提示文字
- **中部**: 响应式网格（桌面 4 列 → 平板 3 列 → 手机 2 列）
- **图片卡片**: 正方形裁切缩略图 + 文件名 + 复制按钮
- **弹窗 (Lightbox)**: 点击图片放大查看，底部有复制链接按钮
- **Toast**: 复制成功时的短暂提示

### 交互
- 点击图片 → 全屏弹窗查看原图
- 点击复制按钮 → 复制 `https://xiaosh.xyz/表情包/xxx.png` 到剪贴板
- 点击遮罩 / ESC / 关闭按钮 → 关闭弹窗
- Toast 提示「✅ 已复制链接」

### 文字
- 提示语: 「点击图片查看大图 · 点击复制按钮获取直链 · 素材来源于网络」
- 无底部版权信息