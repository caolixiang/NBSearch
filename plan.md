# 计划与架构记录

## Phase 0（当前）

- [x] 图片请求增加本地磁盘缓存（Tauri）。
- [x] 设置页增加“清除图片缓存”入口与缓存统计信息。

## 架构决策

1. 桌面端本地缓存根目录统一为用户目录下 `.nbsearch`。
   - 图片缓存路径：`.nbsearch/cache/images`
   - 数据库路径：`.nbsearch/data/chat-app.db`
   - 目标：跨平台统一（macOS / Windows）并便于用户清理。

2. 图片缓存键采用 URL 规范化后哈希，优先复用同一路径资源，减少重复网络请求。
