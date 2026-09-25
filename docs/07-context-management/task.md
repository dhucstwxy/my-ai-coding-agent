# 上下文管理 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/context/constants.ts` | 阈值与默认窗口常量 |
| 新建 | `src/context/estimate.ts` | Token 近似估算与锚点 |
| 新建 | `src/context/state.ts` | 每会话熔断状态 |
| 新建 | `src/context/micro.ts` | 轻量预防 F1/F2 |
| 新建 | `src/context/split.ts` | 近期保留切分（含 F7） |
| 新建 | `src/context/summary.ts` | 摘要 Prompt 与正文提取 |
| 新建 | `src/context/auto.ts` | 重量压缩 |
| 新建 | `src/context/pipeline.ts` | 管线编排 |
| 新建 | `src/context/index.ts` | 导出 |
| 修改 | `src/session/store.ts` | `replaceMessages` / `writeToolResult` |
| 修改 | `src/config/types.ts` | `contextWindow` |
| 修改 | `src/config/load.ts` | 解析 `context_window` |
| 修改 | `.mewcode/config.example.yaml` | 示例字段 |
| 修改 | `src/agent/types.ts` | `compact_*` 事件 |
| 修改 | `src/agent/loop.ts` | 请求前跑管线；更新锚点 |
| 修改 | `src/chat/service.ts` | `/compact` 命令 |
| 修改 | `src/tui/chat-screen.tsx` | 展示 compact 提示 |

## T1: 常量

**文件：** `src/context/constants.ts`  
**依赖：** 无  
**步骤：**
1. 导出与 plan 一致的数值常量：`SINGLE_TOOL_RESULT_TOKENS=20000`、`MESSAGE_TOOL_RESULTS_TOKENS=40000`、`AUTO_RESERVE_TOKENS=13000`、`MANUAL_RESERVE_TOKENS=3000`、`KEEP_RECENT_TOKENS=10000`、`KEEP_RECENT_MIN_MESSAGES=5`、`SUMMARY_FAIL_LIMIT=3`、`DEFAULT_CONTEXT_WINDOW=128000`、`CHARS_PER_TOKEN=4`

**验证：** `npm run typecheck` 不因本文件报错

## T2: Token 估算

**文件：** `src/context/estimate.ts`  
**依赖：** T1  
**步骤：**
1. 导出 `estimateChars(text: string): number` = `Math.ceil(text.length / CHARS_PER_TOKEN)`
2. 导出 `estimateMessage(msg)`：对 `content` 及可选 `thinkingSummary`、序列化后的 `toolCalls` 累加估算
3. 导出 `estimateMessages(messages): number`
4. 导出类型 `TokenEstimateState`：`anchorInputTokens: number | null`、`anchorMessageCount: number`
5. 导出 `createEstimateState(): TokenEstimateState`（锚点 null、count 0）
6. 导出 `updateAnchor(state, usageInput, messageCount): void`
7. 导出 `estimateWithAnchor(messages, state): number`：有锚点则 `anchor + estimate(messages.slice(anchorMessageCount))`，否则全量估算；若 `messages.length < anchorMessageCount`（历史被压缩变短）则回退为全量估算并建议调用方重置锚点（本函数内直接全量估算）

**验证：** `npx tsx` 断言 `"abcd"` → 1；无锚点时消息越长估算越大；设锚点后只对增量加计。脚本跑完删除

## T3: 熔断状态

**文件：** `src/context/state.ts`  
**依赖：** T1  
**步骤：**
1. 导出 `CompactStateStore` 类（进程内 Map）
2. `isAutoDisabled(sessionId): boolean`
3. `recordFailure(sessionId): { consecutive: number; circuitOpen: boolean }` — 连续失败达 `SUMMARY_FAIL_LIMIT` 时置 `autoCompactDisabled`
4. `recordSuccess(sessionId): void` — 清零失败计数并关闭熔断
5. `reset(sessionId): void` — 删除该会话记录（等同新会话）

**验证：** `npx tsx` 连续 3 次 failure 后 `isAutoDisabled` 为 true；`recordSuccess` 后为 false。脚本跑完删除

## T4: SessionStore 写回与落盘

**文件：** `src/session/store.ts`  
**依赖：** 无  
**步骤：**
1. 新增 `replaceMessages(sessionId, messages: ChatMessage[]): void`：读会话、替换整个 `messages` 数组、更新 `updatedAt`、一次 `write`；会话不存在则抛错
2. 新增 `toolResultDir(sessionId): string` → `path.join(this.dir, sessionId, "tool-results")`
3. 新增 `writeToolResult(sessionId, resultId, content): string`：确保目录存在，写入 `{resultId}.txt`，返回绝对路径
4. 不改变现有 `appendMessage` 行为；列表逻辑仍只扫 `*.json`（忽略会话子目录）

**验证：** 临时目录构造 SessionStore，`appendMessage` 后 `replaceMessages` 为两条，读回条数正确；`writeToolResult` 后文件存在且内容一致。脚本跑完删除临时目录

## T5: 配置 context_window

**文件：** `src/config/types.ts`、`src/config/load.ts`、`.mewcode/config.example.yaml`  
**依赖：** T1（默认值可引用或在 load 内写 128000）  
**步骤：**
1. `ProviderConfig` 增加可选 `contextWindow?: number`
2. 加载 YAML 时解析 `context_window`（正整数）；非法或缺失则不设字段，由调用方用 `DEFAULT_CONTEXT_WINDOW`
3. `config.example.yaml` 在某个 provider 下加注释示例 `# context_window: 128000`

**验证：** `npm run typecheck`；用临时 YAML 含 `context_window: 64000` 加载后该 provider 的 `contextWindow === 64000`

## T6: MicroCompact

**文件：** `src/context/micro.ts`  
**依赖：** T1、T2、T4  
**步骤：**
1. 导出 `microCompact(messages, { sessionId, store }): MicroCompactResult`
2. 已是「预览+路径」形态的工具消息（例如 content 含固定标记或已指向 tool-results）跳过，避免重复落盘
3. F1：`role==="tool"` 且 `estimateMessage` > 20K → `writeToolResult`，content 改为短预览（前约 500 字符）+ 绝对路径说明
4. F2：按助手 `toolCalls` 回合分组（assistant 后紧跟的连续 tool 消息为同组）；组内合计 > 40K 时，按估算从大到小依次对尚未落盘的条目执行 F1，直到合计 ≤ 40K 或无可压项
5. 在内存改完后由调用方 `replaceMessages`；本函数只返回新数组与 `spilledCount`/`changed`

**验证：** `npx tsx` 造一条超大 tool 消息，断言 `changed`、content 含路径、文件可读；造同组多条合计超限，断言较大者优先被替换。脚本与临时目录删除

## T7: 切分 recent/older

**文件：** `src/context/split.ts`  
**依赖：** T1、T2  
**步骤：**
1. 导出 `splitForCompact(messages): CompactSplit`
2. 从尾部累加 token，直到 ≥ `KEEP_RECENT_TOKENS` 或已纳入条数满足后继续保证至少 `KEEP_RECENT_MIN_MESSAGES`（二者取更宽的保留：先保证至少 5 条，若这 5 条不足 10K 则继续向左纳入直到 ≥ 10K，或消息耗尽）
3. F7：若 `older` 末尾（切点左侧）是 `user` 消息，将该消息移入 `recent` 头部；若因此破坏 tool 配对，再向左扩展到配对完整（assistant+tools 不被从中间切断）
4. 若消息太少无法切（例如不足 5 条可丢弃），则 `older=[]`、`recent=全部`（调用方应跳过重量压缩）

**验证：** `npx tsx` 构造 20 条短消息，断言 `recent.length >= 5` 且 `older`+`recent` 拼接等于原数组；在切点左侧放一条 user，断言它出现在 `recent`。脚本跑完删除

## T8: 摘要 Prompt 与提取

**文件：** `src/context/summary.ts`  
**依赖：** 无  
**步骤：**
1. `buildSummaryPrompt({ olderMessages, userNote? })` 返回 `{ system: string; user: string }`
2. system/user 中明确：禁止调用任何工具；先写分析草稿再写正式摘要；正式摘要必须含五段标题（会话意图与目标 / 关键决策与约束 / 已完成工作 / 当前状态与待办 / 相关文件与路径）；草稿用完即弃
3. `user` 中序列化 `olderMessages` 的可读文本；若有 `userNote` 则附加「用户备注」段落
4. `extractFormalSummary(rawText)`：若存在明确分隔（如 `---` 或「正式摘要」标题），取其后正文；否则整段返回（仍应尽量保留五段结构）。丢弃草稿部分

**验证：** `npx tsx` 断言 prompt 字符串包含「禁止」工具语义与五个标题；对含草稿+分隔+正文的样例，提取结果不含草稿关键词。脚本跑完删除

## T9: AutoCompact

**文件：** `src/context/auto.ts`  
**依赖：** T7、T8  
**步骤：**
1. 导出 `autoCompact({ messages, provider, model, thinking?, userNote?, signal? }): Promise<AutoCompactResult>`
2. `splitForCompact`；若 `older` 为空则返回失败「无需压缩」
3. 调用 `provider.streamChat`：`tools` 不传或空数组，`system`/`messages` 来自 summary prompt；收集完整文本（复用现有 collect 或简易拼接 text_delta）
4. `extractFormalSummary`；组装三条结构：`system` 或 `user` 角色的摘要消息（推荐 `role:"user"` 包裹摘要）、边界消息（中文：需文件细节请重新读取，勿按摘要臆造代码）、`...recent`
5. 任何抛错/空摘要 → `{ ok:false, error }`；成功前不写 SessionStore

**验证：** 用假 Provider 返回固定五段文本，断言 `ok` 且结果 messages 以摘要与边界开头、尾部等于 recent。脚本跑完删除

## T10: ContextPipeline

**文件：** `src/context/pipeline.ts`、`src/context/index.ts`  
**依赖：** T3–T6、T9  
**步骤：**
1. `ContextPipeline` 持有 `store`、`provider`、`providerConfig`、`CompactStateStore`、共享的 `TokenEstimateState`（可按 session 分 Map）
2. `run(opts: PipelineRunOptions & { onEvent?: (e) => void })`：
   - micro → 若 changed 则 `replaceMessages` 并 `onEvent(compact_done micro)`
   - 若 `isAutoDisabled` 且非 manual force 成功路径：跳过 auto（manual+force 仍尝试）
   - 估算；`reserve = auto? 13K : 3K`；若 `!force && estimate <= window-reserve` 则结束
   - `onEvent(compact_start auto)` → `autoCompact`；成功 `replaceMessages` + `recordSuccess` + done；失败 `recordFailure`，必要时 `compact_circuit_open` / `compact_failed`
3. manual 成功后必须 `recordSuccess` 以解除熔断
4. `index.ts` 导出管线与常量等公开符号

**验证：** `npx tsx` 用内存假 store/假 provider：超大 tool → micro 写盘；force 路径调用假摘要一次；连续失败 3 次后 auto 不再 attempted。脚本跑完删除

## T11: Agent 事件类型

**文件：** `src/agent/types.ts`  
**依赖：** 无  
**步骤：**
1. 扩展 `AgentEvent`：`compact_start` / `compact_done` / `compact_failed` / `compact_circuit_open`，字段与 plan 一致

**验证：** `npm run typecheck`

## T12: AgentLoop 接入

**文件：** `src/agent/loop.ts`  
**依赖：** T10、T11、T5  
**步骤：**
1. 构造或注入 `ContextPipeline`（及 per-session 估算状态）
2. 每次 `streamChat` 之前：读取 session.messages，`pipeline.run({ mode:"auto", force:false, contextWindow: config.contextWindow ?? DEFAULT })`，把事件 yield 出去；用返回的 messages（或重新 get session）组装请求
3. 本轮 `collectStream` 结束后若有 `usage.input`（或现有 TokenUsageInfo 字段），`updateAnchor`
4. 压缩变短后若估算回退全量，同步把该 session 锚点重置为 null

**验证：** `npm run typecheck`；现有单元/启动不报错

## T13: `/compact` 命令

**文件：** `src/chat/service.ts`  
**依赖：** T10、T11、T12  
**步骤：**
1. 解析 `/compact` 与 `/compact <备注>`（注意不要与 `/plan` 等冲突）
2. 不把命令原文 `appendMessage`；调用 `pipeline.run({ mode:"manual", force:true, userNote })`，yield 事件与简短中文结果
3. 不进入 `runLoop` 任务回合
4. ChatService 需能访问同一 Pipeline 实例（构造时创建并传给 Loop，或 Loop 暴露 pipeline）

**验证：** `npm run typecheck`；`npx tsx` 对 ChatService 打桩：发送 `/compact 测试` 不新增 user 任务消息，且 pipeline 被调用。脚本跑完删除

## T14: TUI 提示

**文件：** `src/tui/chat-screen.tsx`  
**依赖：** T11  
**步骤：**
1. 处理 `compact_start` / `compact_done` / `compact_failed` / `compact_circuit_open`，在状态行或消息区显示中文提示（如「正在压缩上下文…」「已落盘 N 个工具结果」「摘要压缩成功」「自动压缩已熔断」）

**验证：** `npm run typecheck`

## 执行顺序

```
T1 → T2 → T3
T4（可与 T1–T3 并行）
T5（可与 T4 并行）
T2+T4 → T6
T2 → T7
T8（可并行）
T7+T8 → T9
T3+T6+T9 → T10
T11（可早做）
T5+T10+T11 → T12 → T13 → T14
```

推荐串行落地顺序：T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10 → T11 → T12 → T13 → T14。
