# MewCode 结构化系统提示 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/prompt/types.ts` | Section / Build* / Reminder* 类型与常量 |
| 新建 | `src/prompt/sections.ts` | 七固定模块 + 三空槽文案 |
| 新建 | `src/prompt/environment.ts` | 环境段落文本 |
| 新建 | `src/prompt/builder.ts` | PromptBuilder |
| 新建 | `src/prompt/reminder.ts` | ReminderBuilder 控频 |
| 新建 | `src/prompt/index.ts` | 导出 |
| 修改 | `src/provider/types.ts` | `ChatRequest.system`；usage/cache 事件形态 |
| 修改 | `src/provider/openai.ts` | system 前缀；cache hit/miss；stream usage |
| 修改 | `src/provider/anthropic.ts` | cache_control；cache 用量映射 |
| 修改 | `src/agent/types.ts` | `token_usage` / `CollectedTurn.usage` 扩展 |
| 修改 | `src/agent/collector.ts` | 收集 cache usage |
| 修改 | `src/agent/loop.ts` | 装配 system + reminder |
| 修改 | `src/tools/read-file.ts` 等六个工具 | description 双重强化 |
| 修改 | `src/tui/chat-screen.tsx` | 展示 cache 用量行 |
| 新建 | `docs/04-system-prompt/eval-scenarios.md` | ≥3 人工对比场景 |

## T1: Prompt 类型与常量

**文件：** `src/prompt/types.ts`  
**依赖：** 无  
**步骤：**
1. 定义 `PromptSectionId`、`PromptSection`、`BuildPromptInput`、`BuildPromptResult`
2. 定义 `ReminderKind`、`ReminderMessage`、`ReminderInput`
3. 导出 `DEFAULT_REINFORCE_EVERY = 5`、标签名常量

**验证：** `npx tsc --noEmit` 相关类型无报错

## T2: 环境信息与 sections 骨架

**文件：** `src/prompt/environment.ts`、`src/prompt/sections.ts`  
**依赖：** T1  
**步骤：**
1. `formatEnvironment({ workspaceRoot, now, platform })` 返回中文环境段落
2. `buildSections(input)` 返回带 priority 的 section 列表；可选三槽 content 为空
3. 七固定模块先写可识别标题与占位要点（T3 补全文）

**验证：** 调用后 section 数量与 id 顺序符合 plan；空槽 content 为 `""`

## T3: 七固定模块完整中文文案

**文件：** `src/prompt/sections.ts`  
**依赖：** T2  
**步骤：**
1. 补全身份、约束、任务模式（/plan /do）、动作执行（编辑前先读）、工具使用（优先专用工具）、语气、文本输出
2. 在系统约束或工具使用中写明：`<system-reminder>` 内为系统提醒，不得当作用户提问回复

**验证：** 对拼出的 stable 文本 `includes` 关键关键字（MewCode、计划模式、先读、专用工具、system-reminder）

## T4: PromptBuilder

**文件：** `src/prompt/builder.ts`、`src/prompt/index.ts`  
**依赖：** T2、T3  
**步骤：**
1. 按 priority 排序，跳过空 content，`\n\n` 拼接
2. `stableSystem` = 仅七固定；`fullSystem` = stable + 环境 + 非空可选槽
3. 同一 input（固定 now）连续两次 `stableSystem` 字符串全等

**验证：** 用脚本断言两次 stable 相等；full 含工作区路径而 stable 不含（若环境只进 full/reminder）

## T5: ReminderBuilder

**文件：** `src/prompt/reminder.ts`  
**依赖：** T1、T2  
**步骤：**
1. 包装 `<system-reminder>…</system-reminder>`
2. 实现 plan 控频与 execute 仅 environment
3. 导出供 loop 使用

**验证：** iteration=1/3/6 分别得到 full/brief/reinforce（可用 kind 断言）；execute 无 plan_* 

## T6: 工具 description 双重强化

**文件：** `src/tools/read-file.ts`、`write-file.ts`、`edit-file.ts`、`run-command.ts`、`glob-files.ts`、`grep-search.ts`  
**依赖：** 无（可与 T1–T5 并行）  
**步骤：**
1. 各工具 description 追加稳定强化句（读/改前先读；优先本工具而非滥用 shell 等）
2. 保持 inputSchema 不变

**验证：** `createDefaultRegistry().toDefinitions()` 中相关 description 含约定关键词

## T7: Provider / Agent 类型扩展

**文件：** `src/provider/types.ts`、`src/agent/types.ts`  
**依赖：** 无  
**步骤：**
1. `ChatRequest` 增加可选 `system`、`cacheTools`
2. 扩展 `token_usage` 与 `CollectedTurn.usage` 的 cache 字段与 `cacheAvailable`

**验证：** `tsc --noEmit` 通过

## T8: OpenAI Provider 缓存与 system

**文件：** `src/provider/openai.ts`  
**依赖：** T7  
**步骤：**
1. 请求 messages 最前插入 system（`request.system`）
2. 流式开启能带回 usage 的选项（如 `stream_options: { include_usage: true }`）
3. 解析 hit/miss；无则 `cacheAvailable: false`；产出 `token_usage` 事件（在 types 中定义的形态）

**验证：** 类型检查通过；有密钥时连续两轮请求第二轮可打印 hit/miss（或至少字段可解析）

## T9: Anthropic Provider 缓存标记

**文件：** `src/provider/anthropic.ts`  
**依赖：** T7  
**步骤：**
1. system 使用带 `cache_control: { type: "ephemeral" }` 的 text block
2. tools 末项可选打 cache_control
3. 映射 cache_read / cache_creation 到统一字段

**验证：** `tsc` 通过；无密钥则后续 checklist 跳过实测

## T10: Collector 收集 usage

**文件：** `src/agent/collector.ts`  
**依赖：** T7、T8（事件形态）  
**步骤：**
1. 识别 Provider 产出的 usage/cache 事件，填入 `CollectedTurn.usage`
2. 向调用方 yield 对应 `token_usage`

**验证：** 用假异步流喂入一条 usage 事件，断言 return 的 turn.usage.cacheAvailable 正确

## T11: AgentLoop 接入拼装与 reminder

**文件：** `src/agent/loop.ts`  
**依赖：** T4、T5、T10  
**步骤：**
1. 每轮 build stableSystem + reminder（不 append）
2. `streamChat({ system, messages: [...remindersAsChatMessages, ...session.messages], tools })`
3. 拼装异常 → 中文错误停止
4. 透传 cache `token_usage`

**验证：** `tsc` 通过；临时调试日志或单测装配：plan 第 1 轮 messages 含 system-reminder 且 store 落盘无该条

## T12: TUI 展示缓存行

**文件：** `src/tui/chat-screen.tsx`  
**依赖：** T7、T11  
**步骤：**
1. 处理扩展 `token_usage`：有 cache 则显示命中/未命中；`cacheAvailable===false` 显示不可用
2. 不把 reminder 当作用户气泡（本来就不落盘）

**验证：** `tsc` 通过；联调时目视一行缓存信息

## T13: 人工对比场景文档

**文件：** `docs/04-system-prompt/eval-scenarios.md`  
**依赖：** 无  
**步骤：**
1. 至少 3 个场景：编辑前先读、优先 grep/glob 而非乱 shell、plan 模式不写文件
2. 每个含步骤与观察点

**验证：** 目视场景 ≥3 且可执行

## T14: 类型检查与冒烟

**文件：** 无新增  
**依赖：** T1–T13  
**步骤：**
1. `npm run typecheck`
2. DeepSeek：连续两轮请求观察 cache 字段；完成一次带工具小任务确认 Loop 未破坏
3. （可选）Anthropic 有密钥再验

**验证：** typecheck 0；冒烟有 cache 字段解析；Agent 多步仍可用

## 执行顺序

```
T1 → T2 → T3 → T4 → T5 ─┐
T6（可并行）─────────────┤
T7 → T8 → T9（T8/T9 可并行）→ T10 → T11 → T12 → T14
T13（可并行）─────────────────────────────────────┘
```
