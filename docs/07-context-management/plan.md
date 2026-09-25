# 上下文管理 Plan

## 架构概览

在 Agent Loop 每次调用模型之前，插入一条 **上下文管线（Context Pipeline）**；压缩结果通过 SessionStore **整表替换**写回。

| 组件 | 职责 |
|------|------|
| **TokenEstimator** | 以最近一次 API `usage.input`（或等价字段）为锚点；对锚点之后的增量消息按字符近似折算 tokens |
| **MicroCompact** | 轻量预防：超阈值工具结果落盘，消息改为预览+路径并写回 |
| **AutoCompact** | 重量兜底：组摘要请求（无工具）→ 解析五段正文 → 组装「摘要 + 边界消息 + 近期原文」 |
| **ContextPipeline** | 编排：先 Micro，再按阈值/熔断决定是否 Auto；对外统一入口 |
| **CompactState** | 每会话熔断计数与是否禁用自动重量压缩 |
| **SessionStore 扩展** | `replaceMessages` 原子写回；tool-results 路径与落盘 |
| **配置扩展** | `ProviderConfig.contextWindow`，默认 128000 |
| **事件 / TUI** | `compact_*` 事件，界面提示开始/成功/失败/熔断 |
| **ChatService** | 解析 `/compact [备注]`，走手动压缩路径（3K 余量，强制执行一次） |

数据流（每次模型请求前）：

```
session.messages
     ↓
MicroCompact（F1/F2）→ 可能 replaceMessages
     ↓
TokenEstimator.estimate
     ↓
是否超窗 − 余量？且未熔断？
     ↓ yes
AutoCompact（摘要 LLM，无工具）
     ↓ 成功则一次性 replaceMessages
再 streamChat(…最新 messages…)
```

与 spec 映射：F1–F2→Micro；F3→Pipeline；F4–F7→Auto；F8→ChatService；F9→Estimator；F10→Config；F11→CompactState；F12→Events/TUI。

## 核心数据结构

### CompactThresholds（常量/可配置默认）

- `singleToolResultTokens = 20_000`
- `messageToolResultsTokens = 40_000`
- `autoReserveTokens = 13_000`
- `manualReserveTokens = 3_000`
- `keepRecentTokens = 10_000`
- `keepRecentMinMessages = 5`
- `summaryFailLimit = 3`
- `defaultContextWindow = 128_000`
- 字符→token 近似：`charsPerToken`（默认 `4`，即 `ceil(chars / 4)`）

### TokenEstimateState

- `anchorInputTokens: number | null` — 最近一次请求的 input usage
- `anchorMessageCount: number` — 锚定时已计入的会话消息条数（不含临时 reminder）
- 用途：下一次估算 = `anchorInputTokens + sum(estimate(messages[anchorMessageCount…]))`；无锚点时对全量消息做字符估算

### MicroCompactResult

- `messages: ChatMessage[]` — 处理后的消息
- `spilledCount: number`
- `changed: boolean`

### CompactSplit

- `older: ChatMessage[]` — 送去摘要的较早消息
- `recent: ChatMessage[]` — 保留原文的近期消息（≥5 条或约 10K tokens，并按 F7 尽量把边界附近的用户消息留在 recent）

### SummaryPromptInput

- `olderMessages: ChatMessage[]`
- `userNote?: string` — `/compact` 备注
- 输出：系统/用户提示词文本（含五段标题、禁工具、先草稿后正文）

### AutoCompactResult

- `ok: true` → `messages: ChatMessage[]`（摘要消息 + 边界消息 + recent）
- `ok: false` → `error: string`

### CompactState（按 sessionId）

- `consecutiveSummaryFailures: number`
- `autoCompactDisabled: boolean`
- 方法语义：`recordSuccess()` / `recordFailure()` / `reset()`（新会话或成功手动压缩时）

### PipelineRunOptions

- `sessionId: string`
- `messages: ChatMessage[]`
- `contextWindow: number`
- `mode: "auto" | "manual"`
- `userNote?: string`
- `force: boolean` — 手动 `/compact` 时为 true（未过阈值也压）

### PipelineRunResult

- `messages: ChatMessage[]`
- `micro: MicroCompactResult` 摘要信息
- `auto?: { attempted: boolean; succeeded?: boolean; error?: string; circuitOpen?: boolean }`

### 事件（扩展 AgentEvent）

- `compact_start`：`{ layer: "micro" | "auto"; trigger: "auto" | "manual" }`
- `compact_done`：`{ layer; spilledCount?; removedMessageCount?; keptMessageCount? }`
- `compact_failed`：`{ layer: "auto"; error: string; consecutiveFailures: number }`
- `compact_circuit_open`：本会话自动重量压缩已熔断

### ProviderConfig 扩展

- `contextWindow?: number` — YAML 字段 `context_window`；缺省 `128000`

### SessionStore 扩展 API

- `replaceMessages(sessionId, messages)` — 整表替换，一次落盘（满足 N2）
- `toolResultPath(sessionId, resultId)` / `writeToolResult(sessionId, resultId, content)`

## 模块设计

### `context/estimate.ts` — TokenEstimator

**职责：** 近似估算当前会话上下文 tokens。  
**对外：** `estimateChars(text) → number`；`estimateMessages(messages)`；`updateAnchor(usageInput, messageCount)`；`estimateWithAnchor(messages, state)`。  
**依赖：** 无。

### `context/micro.ts` — MicroCompact

**职责：** F1/F2。识别工具消息；单条超 20K 则落盘并替换为预览+路径；按「助手 toolCalls 回合」分组，合计超 40K 时从大到小依次落盘。  
**对外：** `microCompact(messages, { sessionId, store }) → MicroCompactResult`。  
**依赖：** SessionStore 写 tool-result、TokenEstimator。

### `context/split.ts` — 保留窗口切分

**职责：** 从尾部按 token 累加，满足约 10K 或至少 5 条；若切点左侧紧邻用户消息，向左扩展把该用户消息（及必要成对上下文）划入 recent（F7）。  
**对外：** `splitForCompact(messages) → CompactSplit`。  
**依赖：** TokenEstimator。

### `context/summary.ts` — 摘要 Prompt 与解析

**职责：** 构造禁止工具、先草稿后五段正文的提示词；从模型输出中丢弃草稿、提取正式摘要。  
**对外：** `buildSummaryPrompt(input)`；`extractFormalSummary(rawText) → string`。  
**依赖：** 无（纯文本）。

### `context/auto.ts` — AutoCompact

**职责：** 切分 → 调 Provider（同模型、`tools` 为空）→ 提取摘要 → 组装摘要消息 + 边界消息 + recent；失败不写盘。  
**对外：** `autoCompact(opts) → AutoCompactResult`。  
**依赖：** split、summary、ChatProvider、TokenEstimator。

### `context/pipeline.ts` — ContextPipeline

**职责：** F3 编排；维护 CompactState；先 micro（有变更则 `replaceMessages`），再按 `estimate > window - reserve`（或 `force`）决定 auto；成功则一次 `replaceMessages`；失败累加熔断。  
**对外：** `run(options) → PipelineRunResult`（并通过回调/事件上报进度）。  
**依赖：** micro、auto、estimate、SessionStore、CompactState。

### `context/state.ts` — CompactStateStore

**职责：** 进程内按 sessionId 保存失败次数与熔断标记；新会话无记录即视为清零。  
**对外：** get / recordSuccess / recordFailure / isAutoDisabled。

### Session / Config / Agent / Chat / TUI 改动

- **SessionStore**：`replaceMessages`；`writeToolResult`；路径 `sessions/{sessionId}/tool-results/{id}.txt`（会话 JSON 仍为 `sessions/{sessionId}.json`）
- **config**：解析 `context_window` → `contextWindow`
- **AgentLoop**：每次 `streamChat` 前调用 Pipeline（`mode:"auto"`）；用返回的 messages 发请求；usage 回来后更新 Estimator 锚点
- **ChatService**：识别 `/compact` / `/compact …备注`；不把命令本身写入用户消息；调用 Pipeline（`mode:"manual", force:true`）；只压缩并提示结果，不自动开聊
- **AgentEvent + TUI**：处理 `compact_*` 事件并展示

## 模块交互

### 自动路径（每次 `streamChat` 前）

```
AgentLoop.iteration
  → ContextPipeline.run({ mode:"auto", force:false })
       → MicroCompact
            若 changed → SessionStore.replaceMessages + yield compact_done(micro)
       → TokenEstimator.estimateWithAnchor
       → 若 autoCompactDisabled → 跳过重量层
       → 若 estimate ≤ window − 13K → 结束管线
       → yield compact_start(auto)
       → AutoCompact
            splitForCompact → buildSummaryPrompt
            → provider.streamChat({ tools: 无, messages: 摘要对话 })
            → extractFormalSummary
            → 组装 [summaryMsg, boundaryMsg, ...recent]
       → 成功：replaceMessages + CompactState.recordSuccess + compact_done(auto)
       → 失败：不写盘 + recordFailure；若达 3 次 → compact_circuit_open
  → provider.streamChat(正常对话，tools 照旧，messages = 管线后历史 + reminders)
  → collectStream 拿到 usage → TokenEstimator.updateAnchor
```

### 手动路径（`/compact [备注]`）

```
ChatService.send
  → 解析备注，不 append 用户命令原文
  → ContextPipeline.run({ mode:"manual", force:true, userNote, reserve:3K })
       （仍先 Micro；重量层 force 必跑；成功则解除熔断）
  → 向用户 yield 文本/compact_* 结果
  → 不进入 AgentLoop 任务回合
```

### 写盘原子性（N2）

- Micro：在内存合并全部工具消息替换后，一次 `replaceMessages`
- Auto：摘要未成功前零写盘；成功后一次替换为完整新列表

### 临时 reminder

- 不计入 Session、不参与 Micro/Auto 切分
- 估算只对 `session.messages`；reminder 带来的误差由 13K/3K 安全余量吸收

## 文件组织

```
src/
├── context/
│   ├── constants.ts    — 阈值与默认窗口
│   ├── estimate.ts     — TokenEstimator / 锚点状态
│   ├── micro.ts        — 轻量预防 F1/F2
│   ├── split.ts        — 近期保留切分（含 F7）
│   ├── summary.ts      — 摘要 Prompt 与正文提取
│   ├── auto.ts         — 重量压缩
│   ├── state.ts        — 每会话熔断状态
│   ├── pipeline.ts     — 编排入口
│   └── index.ts        — 导出
├── session/store.ts    — + replaceMessages / writeToolResult
├── config/types.ts     — + contextWindow
├── config/load.ts      — 解析 context_window
├── agent/loop.ts       — 请求前跑 Pipeline；更新锚点
├── agent/types.ts      — + compact_* 事件
├── chat/service.ts     — /compact 命令
├── tui/chat-screen.tsx — 展示 compact 提示
└── .mewcode/config.example.yaml — 补充 context_window 示例

docs/07-context-management/
├── spec.md
└── plan.md
```

工具结果落盘：`~/.mewcode/sessions/{sessionId}/tool-results/{id}.txt`  
会话文件保持：`~/.mewcode/sessions/{sessionId}.json`

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 写回策略 | 永久 `replaceMessages` | 与已批准 spec 一致；重启行为一致 |
| 估算 | usage 锚点 + 字符/4 | 满足 F9，实现成本低；余量吸收误差 |
| 摘要调用 | 同 Provider/model，tools 为空 | 满足 F5，无新配置面 |
| `/compact` | 只压缩、不开新任务回合 | 命令语义清晰，避免误把备注当用户任务 |
| Micro 与既有截断 | 并存，管线在请求前再压 | 遵守「不做的事」：不重做截断体系 |
| 熔断作用域 | 仅自动重量层；Micro 始终可跑 | 满足 F11 |
| reminder 与估算 | 不入库、估算忽略；靠安全余量 | 避免把临时消息写进会话 |

## Spec 覆盖

| F | 归属 |
|---|------|
| F1–F2 | micro.ts |
| F3 | pipeline.ts + loop.ts |
| F4–F7 | split.ts + auto.ts + summary.ts |
| F8 | chat/service.ts |
| F9 | estimate.ts |
| F10 | config |
| F11 | state.ts + pipeline |
| F12 | agent events + TUI |
