# Phase 7：Web / Tauri 一致性回归记录

## 执行日期

- 2026-02-28

## 目标

- 验证本轮 Phase 2-6 改动后，Web 与 Tauri 的构建链路和运行主链路无回归。
- 覆盖思考区主链路相关能力：解析、状态机、搜索标签/计数、图片渲染替换。

## 执行项

1. 前端预检
- 命令：`bun run release:preflight`
- 结果：通过
  - `bun test`：44 pass / 0 fail
  - `bun run typecheck`：通过
  - `bun run build`：通过

2. Tauri Debug 打包
- 命令：`bun run tauri:build:debug`
- 结果：通过
  - 产物：
    - `src-tauri/target/debug/bundle/macos/Chat App.app`
    - `src-tauri/target/debug/bundle/dmg/Chat App_0.1.0_aarch64.dmg`

3. 关键事件流样本核对（网关）
- `grok-4` 流式包含：
  - `response.tool_usage_card`
  - `search_images`
  - `raw_function_result.webSearchResults`（数组）
  - `<think>...</think>`
- `grok-4.1-fast` 流式包含：
  - `response.output_text.delta`
  - `response.completed.image_generation.data[]`
  - `title.newTitle`

## 结论

- 工程层回归（测试/类型/构建/Tauri 打包）通过。
- 思考区主链路的解析与渲染路径可用：
  - `raw_function_result` 计数可计算（数组与 `results[]` 对象均支持）。
  - `cardAttachment.jsonData` / `cardAttachmentsJson[]` 可进入卡片池。
  - `grok:render`（成对或自闭合）可替换为 Markdown 图片。

## 备注

- 视觉“像素级”最终验收仍需以实际 UI 人工比对为准（官方截图 + 本地运行画面）。
