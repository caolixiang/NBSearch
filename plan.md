# Chat App 去 Next.js + Tauri 客户端化实施计划

## 执行状态

- [x] Phase 0
- [ ] Phase 1
- [ ] Phase 2
- [ ] Phase 3
- [ ] Phase 4
- [ ] Phase 5
- [ ] Phase 6
- [ ] Phase 7
- [ ] Phase 8

## 目标与边界

- 目标：将当前 `Next.js` 项目迁移为 `Tauri + Vite + React` 桌面客户端。
- 重点复用：现有 UI 视觉与交互层（以 `components/*` 为主）。
- 明确声明：除 UI 外，路由、数据层、网络层、状态管理、存储层、工程结构与构建链路均可重写，不受现有实现约束。
- 固定技术决策：
  - 仅使用 `AI SDK` 体系，不引入 `openai` 原生 SDK。
  - 多模型通过 AI SDK provider 路由：
    - OpenAI-compatible provider -> 你的网关 `/v1/responses`
    - Anthropic provider -> Claude `/v1/messages`
  - 前端与构建工具链统一使用 `Bun`，不保留 `Node` 兜底路径。
- 必须能力：
  - 文本对话走 `/v1/responses`（流式）。
  - 语音走 `LiveKit/WebRTC` + 网关语音接口。
  - 本地持久化 `session_id / conversation_id / response_id / 聊天记录`。

## Phase 0: 基线冻结与迁移准备

- 目标：确保迁移可回滚、可对比、可验收。
- 任务：
  - 建立迁移分支（例如 `feat/tauri-migration`）。
  - 记录当前可运行基线（截图 + 关键交互路径）。
  - 抽取关键业务流程清单：发消息、流式展示、切模型、语音入口、主题切换。
  - 固化运行时约束：`Bun >= 1.x`（版本写入项目文档和 CI）。
  - 约定环境变量命名与配置来源（开发/生产）。
- 产出：
  - 迁移基线文档（可放 `docs/migration-baseline.md`）。
  - Bun 工具链约束说明（安装、版本、命令约定）。
  - 验收清单初稿（后续每个 Phase 更新）。
- 验收标准：
  - 当前版本可稳定启动，关键路径可复现。

## Phase 1: 重建应用骨架（仅迁 UI）

- 目标：直接建立新架构，不对旧 Next 代码做兼容性重构。
- 任务：
  - 新建干净的前端骨架（Vite + React + TypeScript），不沿用 `app/*` 路由与 `app/api/*`。
  - 从旧项目选择性迁移 UI 组件、样式 token、图标与交互细节。
  - 新建聊天领域接口层（message/session/storage/voice），按新架构重新定义类型与边界。
  - 明确旧逻辑处理原则：
    - UI 可复用
    - 非 UI 逻辑默认重写
- 产出：
  - 全新骨架 + 可复用 UI 组件集 + 新版接口层约定。
- 验收标准：
  - 新工程可独立运行且 UI 主界面可展示，不依赖旧 Next 运行时。

## Phase 2: 前端壳替换为 Vite + React

- 目标：完成“去 Next.js”核心切换。
- 任务：
  - 初始化 `Vite + React + TypeScript` 工程。
  - 构建命令统一为 Bun（`bun install`、`bun run dev/build`）。
  - 迁移并适配目录与别名（`@/components`, `@/hooks`, `@/lib`）。
  - 迁移全局样式与 Tailwind 配置。
  - 新建入口：`index.html` + `src/main.tsx` + `src/App.tsx`。
  - 将原 `app/page.tsx` 页面组合逻辑迁移至 `App`。
  - 去除 Next 专属依赖与配置文件。
- 产出：
  - 可独立运行的 Web 前端（Vite）。
- 验收标准：
  - `bun run dev` 可正常启动。
  - 主聊天页面视觉与交互与基线一致（允许轻微样式偏差）。

## Phase 3: 接入 Tauri 桌面容器

- 目标：从 Web 开发态进入桌面应用运行态。
- 任务：
  - 初始化 Tauri（`src-tauri`、`tauri.conf.json`）。
  - 配置开发命令（Bun + Vite dev server + Tauri dev）。
  - 定义应用级配置读取（网关 URL、默认模型等）。
  - 对接系统能力占位：
    - 应用版本/平台信息
    - 日志目录
    - 应用数据目录
- 产出：
  - 可运行的 Tauri 桌面应用壳。
- 验收标准：
  - `tauri dev` 成功启动桌面窗口并加载主界面。

## Phase 4: 本地数据持久化（SQLite）

- 目标：完成会话锚点与消息持久化，支持重启恢复。
- 任务：
  - 接入 `tauri-plugin-sql`（或等价 SQLite 方案）。
  - 建立迁移脚本与 schema 版本控制。
  - 建表建议：
    - `conversations(id, title, session_id, conversation_id, last_response_id, created_at, updated_at)`
    - `messages(id, conversation_id, role, content_json, response_id, previous_response_id, status, created_at)`
    - `voice_sessions(id, conversation_id, livekit_room, request_id, started_at, ended_at, status)`
  - 实现 repository 层：
    - upsert conversation anchors
    - append message
    - stream 中间态更新（`status=streaming/completed/failed`）
- 产出：
  - 本地数据库与读写层。
- 验收标准：
  - 重启应用后可恢复会话列表与最后上下文。
  - 每轮对话能正确保存 `response_id`。

## Phase 5: 文本对话接入网关 `/v1/responses`

- 目标：通过 AI SDK 统一编排多 provider，主链路使用网关 responses，并可切 Claude。
- 任务：
  - 实现 provider router（按模型或策略分发）：
    - OpenAI-compatible provider -> 网关 `POST /v1/responses`
    - Anthropic provider -> Claude `POST /v1/messages`
  - 改造 chat service（统一调用入口）：
    - 通过 `AI SDK` 抽象层发起请求与流式消费
    - `stream: true` 的 SSE/流式解析
    - 统一错误映射（401/429/5xx）
  - 实现 `AI SDK` 自定义适配层，兼容网关返回格式与事件流。
  - 会话锚点策略：
    - 首轮生成并保存 `session_id`
    - 保存 `conversation_id`
    - 每轮完成保存 `response_id`，并更新 `last_response_id`
  - 将鉴权与端点配置抽象为 provider config（方便多环境切换）。
- 产出：
  - 稳定的多 provider 文本流式链路（客户端 -> AI SDK -> 网关/Claude）。
- 验收标准：
  - 连续多轮对话上下文连续。
  - 网络中断后可恢复并保持本地记录一致性。
  - 同一 UI 下可按模型切换网关与 Claude。

## Phase 6: 语音能力接入（LiveKit/WebRTC）

- 目标：落地实时语音会话，并与文本会话锚点打通。
- 任务：
  - 语音建连流程：
    - `POST /api/v1/voice/token` 获取 `token/url/room/session_id`
    - 前端使用 LiveKit SDK 建立 WebRTC 连接
  - 事件上报流程：
    - `POST /api/v1/voice/session-events`
    - 至少覆盖 `session_connected / conversation_bound / anchor_updated / session_closed`
  - 将语音会话绑定到相同 `session_id`，确保文本/语音共享上下文。
  - 本地保存语音会话摘要与关键事件。
- 产出：
  - 可用的语音对话能力与事件追踪。
- 验收标准：
  - 语音会话结束后，文本聊天可在同一上下文继续。
  - `conversation_id/response_id` 锚点在本地与网关状态一致。

## Phase 7: 收尾清理与稳定性增强

- 目标：移除遗留依赖并提升可维护性。
- 任务：
  - 删除 Next.js 相关文件与依赖：
    - `app/*`
    - `next.config.mjs`
    - `next` / `@vercel/analytics` 等（按实际使用清理）
  - 清理非 Bun 工具链残留（如 `pnpm-lock.yaml`、仅 Node 可用脚本）。
  - 确认无 `openai` 原生 SDK 依赖，仅保留 AI SDK 方案。
  - 梳理并统一配置项、错误码、日志结构。
  - 增加关键自动化测试：
    - 会话持久化
    - 流式中断恢复
    - 语音事件上报幂等
  - 增加迁移说明与开发文档。
- 产出：
  - 无 Next 依赖的稳定版本。
- 验收标准：
  - 全量 lint/test/typecheck 通过。
  - 无残留 Next 路由/API 调用。

## Phase 8: 打包发布与灰度

- 目标：可交付给真实用户安装使用。
- 任务：
  - 配置 Tauri 打包（macOS/Windows）。
  - 配置自动更新策略（如需要）。
  - 灰度发布与回滚预案。
  - 收集首批用户日志与崩溃信息，修复 P0/P1 问题。
- 产出：
  - 可安装包与发布记录。
- 验收标准：
  - 首批用户可稳定完成文本与语音完整流程。

## 关键风险与对策

- 风险：客户端泄漏网关 API Key。
  - 对策：优先使用短期 token、最小权限 key、按设备/用户隔离。
- 风险：流式中断导致本地与服务端锚点不一致。
  - 对策：每轮结束后以服务端返回 `response_id` 为准进行 upsert 校正。
- 风险：语音多连接并发覆盖锚点。
  - 对策：严格遵循网关 `session-events` 活跃 leg 语义，事件加 `event_id` 幂等。
- 风险：AI SDK 与网关 Responses 事件格式存在细节差异。
  - 对策：增加自定义 transport 适配层与协议回归测试（stream/non-stream）。
- 风险：Bun 生态兼容性差异导致构建或插件行为不同。
  - 对策：在 CI 固化 Bun 版本并补充平台回归测试（macOS/Windows）。

## Phase 提交规则

- 每个 Phase 完成后至少 1 个 commit（强制要求）。
- 一个 commit 只能归属一个 Phase，不跨 Phase 混提。
- commit message 建议统一格式：`phase(<n>): <summary>`。
- 每次 Phase 提交前，先对照本文件对应 Phase 的验收标准进行自检。
- 若一个 Phase 需要多次提交，最后一个提交应明确标注该 Phase 完成。

## 执行建议（推荐节奏）

- Week 1: Phase 0-2（去 Next + Vite 跑通）
- Week 2: Phase 3-5（Tauri + 文本链路 + 本地持久化）
- Week 3: Phase 6-7（语音链路 + 收尾稳定）
- Week 4: Phase 8（打包灰度）
