# MewCode Agent Loop Plan

## 架构概览

在现有 Provider / ToolRegistry / SessionStore / TUI 之上，用 **Agent Loop** 替换 `ChatService` 里「单工具 + 二次禁工具文本」编排。

| 组件 | 职责 |
|------|------|
| **AgentLoop** | ReAct 主循环：迭代计数、停止条件、取消检查、驱动「模型回合 → 工具批次 → 回写」 |
| **StreamCollector** | 双路收集：透传 `text_delta` 等给订阅方；攒出本轮完整文本 + 工具调用列表 |
| **事件流** | 统一对外 `AgentEvent`（扩展进度、用量、停止原因等）；TUI 只订阅 |
| **ToolScheduler** | 按只读/副作用分批：只读并发，副作用串行 |
| **PlanMode** | 会话级 `/plan`/`/do`；决定本轮暴露的工具子集 |
| **CancelToken** | 忙碌时 Esc 置位；Loop 在迭代间隙与批次间隙检查 |
| **ChatFacade** | 解析斜杠命令、启动 Loop、把事件流交给 TUI（由现 `ChatService` 演进） |
| **既有层** | Provider 流式+工具解析、Registry、Session 落盘、六工具 — 尽量复用 |

主路径：

```
用户输入 →（/plan|/do 切模式）→ AgentLoop
  → Provider.streamChat(+当前工具集)
  → StreamCollector（推 UI + 攒完整）
  → 无工具？ stop completed
  → ToolScheduler 执行 → 回写历史 → 下一迭代
  → 触顶/取消/未知×2/错误 → stop + 原因事件
```

与 spec：F1–F6→Loop 停止条件；F7–F9→事件+Collector；F10→Scheduler；F11→Session；F12–F14→PlanMode；F15→替换旧编排；F16→复用双 Provider；F17→TUI 订事件。

## 核心数据结构

### AgentMode
- `"plan"` | `"execute"` — 会话当前模式（默认 `execute`）

### StopReason
- `"completed"` | `"max_iterations"` | `"cancelled"` | `"unknown_tools"` | `"error"`

### AgentEvent
- 复用既有流事件：`text_delta`、`thinking_*`、`tool_call_*`、`tool_execution_*`、`error`、`done`
- 新增：
  - `{ type: "agent_progress"; iteration: number; maxIterations: number }`
  - `{ type: "token_usage"; inputTokens?: number; outputTokens?: number }`
  - `{ type: "agent_stopped"; reason: StopReason; message: string }`
  - `{ type: "mode_changed"; mode: AgentMode }`

### CollectedTurn
- `text: string`
- `toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> | string; parseError?: string }>`
- `usage?: { inputTokens?: number; outputTokens?: number }`

### CancelToken
- `isCancelled: boolean`
- `cancel(): void`

### AgentLoopOptions
- `maxIterations: number`（默认 20）
- `unknownToolLimit: number`（默认 2）
- `readonlyTools` / `sideEffectTools` 名称列表（或依赖工具上的 `sideEffect` 标记）

### AgentLoop
- `run(sessionId: string, userText: string, opts: { cancel: CancelToken; mode: AgentMode }): AsyncIterable<AgentEvent>`

### StreamCollector
- `collect(stream: AsyncIterable<StreamEvent>, onEvent: (e: AgentEvent) => void): Promise<CollectedTurn>`

### ToolScheduler
- `executeBatch(...): AsyncIterable<AgentEvent>` — 只读并发、副作用串行，检查 CancelToken

### PlanModeStore
- `getMode(sessionId): AgentMode`
- `setMode(sessionId, mode): void`
- `filterToolsForMode(registry, mode): ToolDefinition[]`

### ChatFacade
- `send(sessionId, userText): AsyncIterable<AgentEvent>`
- `getCancelToken()` / 每次 send 绑定 token，供 TUI `cancel()`
- 解析 `/plan`、`/do`

### Tool
- 增加 `sideEffect: boolean`

## 模块设计

### `src/agent/types.ts`
AgentMode、StopReason、AgentEvent、CollectedTurn、Options。

### `src/agent/cancel.ts`
`createCancelToken()`。

### `src/agent/collector.ts`
双路收集 Provider 流。

### `src/agent/scheduler.ts`
工具批次调度与 `tool_execution_*` 事件。

### `src/agent/plan-mode.ts`
会话模式 Map + 工具过滤（plan 仅三只读）。

### `src/agent/loop.ts`
ReAct 主循环与停止条件。

### `src/chat/service.ts`
改造为 Facade；删除旧「单工具+二次禁工具」逻辑。

### `src/tools/*`
六工具标注 `sideEffect`；types/registry 支持查询。

### `src/tui/chat-screen.tsx`
Esc 分流；进度/停止/模式展示。

## 模块交互

### 斜杠命令
```
TUI 提交
  → Facade：/plan|/do 切模式并 mode_changed；有正文则 Loop，仅命令则提示后结束
  → 普通文本：按当前模式 Loop
```

### 单次迭代
```
cancel? → stop cancelled
iteration > max? → stop max_iterations
yield agent_progress
streamChat(filterTools) → Collector
error? → stop error
落盘 assistant
无 toolCalls? → stop completed
Scheduler 批次（未知累计 / 已知清零）
consecutiveUnknown >= 2? → stop unknown_tools
iteration++；重复
```

### 取消
忙碌 Esc → `cancel()`；Loop 间隙停止。空闲 Esc → 返回列表。

### 依赖（无环）
```
TUI → Facade → Loop → Collector / Scheduler / PlanMode
Loop → Provider / SessionStore / Registry
```

## 文件组织

```
docs/03-agent-loop/
├── spec.md / plan.md / task.md / checklist.md

src/agent/
├── types.ts / cancel.ts / collector.ts / scheduler.ts / plan-mode.ts / loop.ts

src/chat/service.ts          — Facade
src/tools/types.ts           — sideEffect
src/tools/{read,glob,grep,write,edit,run}-*.ts — 标注
src/tui/chat-screen.tsx      — Esc / 进度 / 模式

scripts/acceptance-agent-loop.mts — 可选无头验收
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 循环位置 | `src/agent/*` + Facade | 解耦、可测 |
| 事件模型 | 扩展联合类型异步迭代 | F7/F8 |
| 双路流 | Collector 回调 + CollectedTurn | F9 |
| 上限 / 未知 | 20 / 连续 2 次清零规则 | 已确认 |
| 调度 | 只读并发，副作用串行 | F10 |
| Plan | 过滤 definitions | F12 |
| 模式存储 | 进程内 Map | 本轮够用 |
| 取消 | CancelToken；不强制杀进程 | N3 折中 |
| 旧编排 | 删除 | F15 |
| 验收 | DeepSeek 优先 | N6 |

## Spec 覆盖自检

| Spec | 归属 |
|------|------|
| F1–F6 | loop.ts |
| F7–F9 | types + collector + TUI 订阅 |
| F10 | scheduler.ts |
| F11 | loop + SessionStore |
| F12–F14 | plan-mode + Facade + TUI |
| F15 | chat/service 改造 |
| F16 | 复用 provider |
| F17 | chat-screen |
| N3–N5 | cancel + scheduler |
