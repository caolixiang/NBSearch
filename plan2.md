# Grok 思考区像素级对齐计划（plan2）

## 执行状态

- [x] Phase 0：验收基线与视觉标尺冻结
- [ ] Phase 1：事件协议对齐（上游 + 前端 contract）
- [ ] Phase 2：解析层重构（无抖动、无丢图）
- [ ] Phase 3：头像系统像素对齐
- [ ] Phase 4：思考区交互与滚动行为对齐
- [ ] Phase 5：搜索条目与计数展示对齐
- [ ] Phase 6：图片结果完整渲染
- [ ] Phase 7：Web/Tauri 一致性与回归

## 目标

- 对齐范围：仅“思考过程/思考结果”相关 UI 与交互（含代理人头像、搜索事件、图片事件、滚动刷新、展开收起）。
- 对齐标准：以 `grok.com` 抓包与截图为准，达到“像素级接近 + 行为一致”。
- 运行范围：Web 与 Tauri 保持一致表现，禁止出现 Web 正常 / Tauri 异常分叉。

## 当前问题与已确认根因

1. 代理人头像资源抓错/映射错位
- 现状：使用了“工具图标序列”作为代理人身份头像，导致观感偏离官方。
- 目标：分离“思考中紧凑头像（黑底图标）”与“思考结果代理人身份头像（彩色像素）”两套体系。

2. 思考区频繁闪烁、一下出现一下消失
- 现状：结构化思考面板与 `<think>` 面板在流式中存在切换抖动；`isThinking` 状态受多类事件影响，存在反复开关。
- 目标：单轮消息采用“单一渲染模式锁定 + 稳定高度容器 + 滚动窗口刷新”，避免抖动。

3. 图片无法显示
- 现状：上游日志已包含图片事件，但当前前端未完整消费。
- 已确认日志字段（来自 `log5.txt`）：
  - `cardAttachment.jsonData`
  - `cardAttachmentsJson[]`
  - 文本内 `<grok:render card_id="...">`
  - `webSearchResults.results[]`（含图文检索结果）
- 结论：不是“上游完全没传”，而是现有解析链路与字段契约不一致。

4. URL 展示为百分号编码，不可读
- 现状：思考列表中链接/查询直接展示 `%E5%8D%8E...`。
- 目标：展示层做可逆解码（显示中文），跳转仍使用原始 URL。

5. 搜索事件交互不一致
- 现状：官方是持续滚动刷新；当前实现会突兀重绘或阶段性空白。
- 目标：固定容器、滚动追加、最新项可见、历史可回看。

## 上下游契约基线（本轮冻结）

为避免“前端硬兼容”，本计划要求上游输出统一契约。若上游未满足，优先改上游，不在前端堆分支。

必须字段（思考链路）：
- `isThinking`
- `rolloutId` / `rolloutIds`
- `toolUsageCardId`
- `toolUsageCard`
- `messageTag`

必须字段（搜索链路）：
- `webSearchResults.results[]`（含 `url/title/preview`）
- 区分文本搜索与图片搜索（如 `tool_name=web_search` / `search_images`）

必须字段（图片渲染链路）：
- 二选一统一输出（推荐只保留一种）：
  - A: 结构化图片数组（推荐）
  - B: `cardAttachmentsJson + <grok:render card_id>`（若继续沿用）

## Phase 拆分（每个 Phase 至少 1 个 commit）

## Phase 0：验收基线与视觉标尺冻结

- 范围：
  - 从 `/Users/caolixiang/Desktop/grok.com` 与 `log*.txt` 提取“头像、布局、动效、时序”基线。
  - 输出像素指标：间距、圆角、字号、灰度、动画时长、切换节奏。
- 产出：
  - `docs/grok-thinking-baseline.md`
  - 对照截图集（本地路径索引）
- 验收：
  - 能逐条回答“当前实现与官方差异”并具备数值化指标。

建议 commit：
- `phase(0): freeze grok thinking UI baseline and metrics`

## Phase 1：事件协议对齐（上游 + 前端 contract）

- 范围：
  - 固定思考/搜索/图片事件契约，移除模糊字段。
  - 对 `search_images` 与 `web_search` 做明确事件类型区分。
- 产出：
  - `docs/contracts/thinking-events.md`
  - TypeScript 类型定义更新（前端消费模型）
- 验收：
  - 单次请求可稳定拿到：代理人序列、搜索条目、图片条目、完成态。

建议 commit：
- `phase(1): formalize thinking/search/image event contract`

## Phase 2：解析层重构（无抖动、无丢图）

- 范围：
  - 重写思考事件聚合器：同一轮消息采用单状态机。
  - 图片事件进入统一附件池，确保 `<grok:render>` 可解卡片元数据。
  - URL 展示采用 decode（仅显示层），链接保留原始值。
- 产出：
  - 聊天解析层与单测更新。
- 验收：
  - 文本搜索、图片搜索、`grok:render` 三链路均可在一次流式对话中完整呈现。

建议 commit：
- `phase(2): rebuild thinking parser and image attachment pipeline`

## Phase 3：头像系统像素对齐

- 范围：
  - 建立两套头像渲染：
    - 思考中：黑底图标环（紧凑栈）
    - 思考结果：彩色像素代理人头像（身份栈 + 列表）
  - 统一 Grok 主头像、代理人头像、活跃态高亮。
- 产出：
  - `AgentAvatarStack` 重构与样式 token。
- 验收：
  - 与基线截图在结构、配色、层级、动效观感上对齐。

建议 commit：
- `phase(3): implement dual avatar system for thinking and result modes`

## Phase 4：思考区交互与滚动行为对齐

- 范围：
  - 固定高度容器，思考中显示“最新 N 条滚动刷新”，结束后可展开完整列表。
  - 禁止“面板闪烁式挂载/卸载”。
  - 对齐官方“思考过程 -> 思考结果”过渡时机。
- 产出：
  - 稳定状态机与滚动策略。
- 验收：
  - 连续多轮请求不出现“一下有一下没”。

建议 commit：
- `phase(4): stabilize thinking panel state machine and rolling timeline`

## Phase 5：搜索条目与计数展示对齐

- 范围：
  - 行文案对齐：`已经搜索网络 / 已搜索图像 / 已浏览网页`。
  - 每条展示结果计数与来源标识。
  - 搜索中与搜索完成状态区分明显。
- 产出：
  - 搜索列表 UI 与逻辑更新。
- 验收：
  - 与官方相同语义和刷新节奏，不丢计数。

建议 commit：
- `phase(5): align search timeline labels counters and status transitions`

## Phase 6：图片结果完整渲染

- 范围：
  - 支持图片搜索事件直接渲染图组（并排、尺寸控制、懒加载）。
  - 支持正文中 `grok:render` 占位替换。
  - 补齐图片失败态与重试态。
- 产出：
  - 图片渲染组件与解析回归测试。
- 验收：
  - 复现“刘美贤图片查询”场景可稳定出图，不再空白。

建议 commit：
- `phase(6): restore image search rendering and grok render replacement`

## Phase 7：Web/Tauri 一致性与回归

- 范围：
  - 同一请求在 Web 与 Tauri 逐项比对：
    - 头像
    - 思考时间轴
    - 搜索事件
    - 图片渲染
  - 修复 Tauri 专属差异（滚动、输入、布局）。
- 产出：
  - 回归清单与问题闭环记录。
- 验收：
  - Web/Tauri 行为一致，无肉眼差异级故障。

建议 commit：
- `phase(7): close parity gaps between web and tauri for thinking UI`

## 风险与处理

1. 上游字段再次波动
- 处理：在 Phase 1 固定契约并加回归样例，不接受未评审字段漂移。

2. 像素级目标主观化
- 处理：以 `docs/grok-thinking-baseline.md` 数值指标为唯一验收标准。

3. 图片链路跨多字段导致回归风险
- 处理：为 `search_images + cardAttachment + grok:render` 建立端到端测试样例。

## 执行顺序

- 先做 Phase 0-1（冻结标准与契约），再进入 UI 实施 Phase 2-6，最后做 Phase 7。
- 每个 Phase 完成后立即提交，不跨 Phase 混提。
