# Thinking / Search / Image 事件契约（Phase 1）

## 目的

统一上游网关与前端消费模型，消除“字段看起来差不多但语义不同”导致的闪烁、丢图和状态抖动。

## 契约版本

- version: `2026-02-28.r1`
- scope: Responses 流式事件（思考区相关）

## 一、核心事件（必须）

### 1. 思考布局事件

```json
{
  "type": "response.created",
  "response": {
    "id": "resp_xxx",
    "uiLayout": {
      "reasoningUiLayout": "UNIFIED",
      "rolloutIds": ["Grok", "Agent 1", "Agent 2"]
    }
  },
  "isThinking": false
}
```

说明：
- `rolloutIds` 仅用于“代理人身份顺序”，不等价于工具图标序列。
- `isThinking` 作为状态参考，不能直接逐事件驱动 UI 开关。

### 2. 工具调用事件

```json
{
  "type": "response.tool_usage_card",
  "toolUsageCardId": "tool_xxx",
  "toolUsageCard": {
    "toolUsageCardId": "tool_xxx",
    "webSearch": {
      "args": {
        "query": "刘美贤 谷爱凌",
        "num_results": 15
      }
    }
  },
  "messageTag": "tool_usage_card",
  "rolloutId": "Grok",
  "isThinking": true
}
```

同时允许 output item 形态：

```json
{
  "type": "response.output_item.added",
  "item": {
    "type": "function_call",
    "id": "call_xxx",
    "name": "web_search",
    "arguments": "{\"query\":\"...\"}",
    "rollout_id": "Grok"
  }
}
```

### 3. 工具结果事件

统一采用对象形态：

```json
{
  "type": "response.tool_usage_card",
  "toolUsageCardId": "tool_xxx",
  "messageTag": "raw_function_result",
  "rolloutId": "Grok",
  "webSearchResults": {
    "results": [
      {
        "url": "https://baike.baidu.com/item/%E5%88%98%E7%BE%8E%E8%B4%A4/23271179",
        "title": "刘美贤_百度百科",
        "preview": "..."
      }
    ]
  },
  "isThinking": false
}
```

说明：
- `webSearchResults` 统一为对象，前端以 `results.length` 统计。
- 不再输出“有时是数组有时是对象”的混合结构。

## 二、图片事件（必须二选一，推荐 A）

### A. 推荐：结构化图片数组（首选）

```json
{
  "type": "response.completed",
  "response": {
    "image_generation": {
      "data": [
        { "url": "https://.../image1.jpg" },
        { "url": "https://.../image2.jpg" }
      ]
    }
  }
}
```

### B. 兼容路径（当前日志真实存在）

```json
{
  "type": "response.output_text.delta",
  "cardAttachment": {
    "jsonData": "{\"id\":\"b029d0\",\"cardType\":\"image_card\",\"type\":\"render_searched_image\",\"image\":{...}}"
  },
  "token": "<grok:render card_id=\"b029d0\" ...></grok:render>"
}
```

以及最终聚合：

```json
{
  "type": "response.completed",
  "cardAttachmentsJson": [
    "{\"id\":\"b029d0\",\"cardType\":\"image_card\",...}"
  ]
}
```

说明：
- 若继续沿用 B，必须保证 `card_id` 与 `cardAttachment(s)` 的 `id` 可一一匹配。
- 若升级到 A，B 应逐步下线，避免前端双路径长期并存。

## 三、工具分类（必须）

用于思考列表图标与文案：

- `web_search` -> 文本搜索（显示：`已经搜索网络`）
- `search_images` -> 图片搜索（显示：`已搜索图像`）
- 其它工具 -> 通用工具展示

## 四、URL 展示规则

- 传输层：保留原始 URL（可包含 percent-encoding）。
- 展示层：允许 decode 为可读中文路径（例如百度百科词条）。
- 跳转层：必须仍使用原始 URL，确保可访问与可复现。

## 五、状态机要求（前端消费约束）

- 不允许“每个 `isThinking` 事件直接开关 UI”。
- UI 思考状态由聚合器得出：
  - 至少一个工具调用在进行中 -> thinking
  - 工具链路闭环 + 无新增思考条目 -> 可收起
- 同一轮消息渲染模式锁定：
  - 一旦进入 structured thinking，不再回退到 legacy `<think>` 面板。

## 六、验收样例

- 文本搜索：`log4.txt`（天气）
- 文本 + 图片搜索 + grok:render：`log5.txt`（刘美贤）

通过条件：
- 思考区无闪烁。
- 搜索条目滚动稳定。
- 图片稳定渲染。
- URL 展示可读（中文路径可见）。
