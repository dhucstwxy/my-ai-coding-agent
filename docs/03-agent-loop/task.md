# MewCode Agent Loop Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/agent/types.ts` | AgentMode、StopReason、AgentEvent、CollectedTurn、Options |
| 新建 | `src/agent/cancel.ts` | CancelToken |
| 新建 | `src/agent/collector.ts` | 双路流式收集 |
| 新建 | `src/agent/scheduler.ts` | 只读并发 / 副作用串行 |
| 新建 | `src/agent/plan-mode.ts` | 会话模式与工具过滤 |
| 新建 | `src/agent/loop.ts` | ReAct 主循环 |
| 修改 | `src/tools/types.ts` | Tool 增加 `sideEffect` |
| 修改 | `src/tools/read-file.ts` 等六工具 | 标注 sideEffect |
| 修改 | `src/tools/registry.ts` | 按需支持 sideEffect 查询 / 过滤辅助 |
| 修改 | `src/provider/types.ts` | 将 Agent 扩展事件并入或 re-export（保持 TUI 可辨） |
| 修改 | `src/chat/service.ts` | Facade：斜杠命令 + Loop + cancel |
| 修改 | `src/tui/chat-screen.tsx` | Esc 分流；进度/停止/模式 UI |
| 修改 | `src/tui/message-list.tsx` | 如需展示 agent_progress / stopped（可轻量） |
| 新建 | `scripts/acceptance-agent-loop.mts` | 无头验收脚本 |
| 新建 | `docs/03-agent-loop/task.md` | 本文档 |

## T1: Agent 类型与 CancelToken

**文件：** `src/agent/types.ts`、`src/agent/cancel.ts`  
**依赖：** 无  
**步骤：**
1. 定义 `AgentMode`、`StopReason`、`CollectedTurn`、`AgentLoopOptions` 默认值（maxIterations=20，unknownToolLimit=2）
2. 定义 `AgentEvent`：在既有流事件基础上增加 `agent_progress` / `token_usage` / `agent_stopped` / `mode_changed`
3. 实现 `createCancelToken()`

**验证：** `npx tsc --noEmit` 对上述文件无报错（或全项目 typecheck 在后续任务再跑通）

## T2: 工具 sideEffect 标注

**文件：** `src/tools/types.ts`、六工具文件、`registry.ts`（如需）  
**依赖：** 无（可与 T1 并行）  
**步骤：**
1. `Tool` 增加 `sideEffect: boolean`
2. read/glob/grep → false；write/edit/run → true
3. Registry 提供 `isSideEffect(name)` 或调用方读 tool.sideEffect

**验证：** 创建默认 registry 后，三只读 `sideEffect===false`，三副作用为 true

## T3: StreamCollector

**文件：** `src/agent/collector.ts`  
**依赖：** T1  
**步骤：**
1. 实现 `collect(stream, onEvent)`：透传事件给 `onEvent`
2. 聚合 text、tool_call_end 列表；可选 usage
3. 遇 `error` 仍返回已收集内容并抛出或标记，约定与 Loop 一致（建议：error 事件透传，collect resolve 但 turn 带 error 标记，或 reject）

**验证：** 用假 AsyncIterable 产出 text_delta + 两个 tool_call_end + done，断言 CollectedTurn 字段正确且 onEvent 调用次数匹配

## T4: ToolScheduler

**文件：** `src/agent/scheduler.ts`  
**依赖：** T2  
**步骤：**
1. 拆分只读 / 副作用 / 未知
2. 只读 `Promise.all` 执行并发；副作用顺序执行
3. 产出 `tool_execution_start/end`；未知工具返回结构化失败内容供 Loop 回写
4. 批次前后检查 CancelToken

**验证：** mock 两个只读工具带 delay，断言总耗时接近 max(delay) 而非 sum；再测一个 write 在只读之后串行

## T5: PlanModeStore

**文件：** `src/agent/plan-mode.ts`  
**依赖：** T2  
**步骤：**
1. `Map<sessionId, AgentMode>`，默认 execute
2. `setMode` / `getMode`
3. `filterToolsForMode`：plan 仅三只读定义

**验证：** set plan 后 filter 长度为 3 且名称集合正确；execute 为 6

## T6: AgentLoop 核心

**文件：** `src/agent/loop.ts`  
**依赖：** T3、T4、T5  
**步骤：**
1. 写入 user 消息；循环 iteration 1..max
2. 每轮：progress → stream+collect → 落盘 assistant → 无工具则 completed 停止
3. 有工具则 scheduler → 回写 tool 消息；维护 consecutiveUnknown
4. 处理 cancel / max / unknown×2 / error → `agent_stopped` + `done`

**验证：** mock Provider 两轮（先返回工具再返回纯文本），断言停止 reason=completed 且历史含 tool 结果；maxIterations=1 且总要工具时 reason=max_iterations

## T7: ChatService 改为 Facade

**文件：** `src/chat/service.ts`  
**依赖：** T6  
**步骤：**
1. 删除「只执行第一个工具 + 二次禁工具」路径
2. 解析 `/plan` `/do`（去前缀）；`mode_changed`；仅命令时提示中文并不调用 Loop（或空任务）
3. `send` 创建/复用 CancelToken，调用 `AgentLoop.run`，`yield*` 事件
4. 暴露 `cancelCurrent()` 供 TUI

**验证：** typecheck 通过；用假 Loop 或集成 mock 断言 `/plan` 触发 mode_changed

## T8: TUI Esc 与展示

**文件：** `src/tui/chat-screen.tsx`（必要时 `message-list.tsx`）  
**依赖：** T7  
**步骤：**
1. busy 时 Esc → cancel；空闲 Esc → onBack
2. 展示当前模式（计划/执行）
3. 展示 `agent_progress`（如 3/20）与 `agent_stopped` 中文原因
4. 保留工具与流式文本展示

**验证：** `npx tsc --noEmit`；手工 `npm start` 目视模式行与 Esc 提示文案

## T9: Provider 事件类型对齐

**文件：** `src/provider/types.ts` 与/或 agent 类型 re-export  
**依赖：** T1、T8  
**步骤：**
1. 确保 TUI/Facade 使用的联合类型包含新事件，避免 exhaustive 遗漏
2. 不破坏现有 openai/anthropic 产出的旧事件

**验证：** 全项目 `npm run typecheck` 退出码 0

## T10: 验收脚本

**文件：** `scripts/acceptance-agent-loop.mts`  
**依赖：** T7、T9  
**步骤：**
1. 无头跑：多步工具任务（DeepSeek）
2. 覆盖：completed、max_iterations（调小上限）、unknown 连续 2、cancel 标志、plan 过滤工具数
3. 不打印 api_key

**验证：** `npx tsx scripts/acceptance-agent-loop.mts` 关键核心 PASS（Anthropic 无密钥则跳过）

## 执行顺序

```
T1 ──┬── T3 ──┐
     │        ├── T6 ── T7 ── T8 ── T9 ── T10
T2 ──┴── T4 ──┤
     └── T5 ──┘
```

推荐串行：`T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10`
