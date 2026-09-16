# MewCode 结构化系统提示 Plan

## 架构概览

在第三章 Agent Loop 之上增加 **Prompt 层**，并扩展 Provider / 事件以承载缓存命中。

| 组件 | 职责 |
|------|------|
| **模块正文（sections）** | 七个固定模块的中文文案；可选三槽返回空字符串 |
| **拼装器（builder）** | 按优先级拼接模块，空行分隔；区分「稳定前缀」与「含环境信息的完整 system」 |
| **环境信息** | 工作区、时间、OS 等变化字段，走 reminder，不进稳定前缀字节 |
| **Reminder 注入** | 按迭代轮次生成 `<system-reminder>` 伪用户消息（模式提醒 + 环境）；仅请求时插入 |
| **请求装配** | AgentLoop 每轮：`稳定 system` + 临时 reminder + 历史消息；不落盘 reminder |
| **工具描述强化** | 六个工具 `description` 写入与全局一致的关键规则 |
| **Provider 扩展** | OpenAI：稳定 system 前缀 + 解析 cache hit/miss；Anthropic：system/tools 缓存标记 + 解析 cache 用量 |
| **事件扩展** | `token_usage` 增加可选缓存命中字段；TUI/日志可展示 |
| **对比场景文档** | `docs/04-system-prompt/eval-scenarios.md` 列出人工对比任务 |

数据流（每轮模型调用）：

```
sections → builder.buildStable()     → system（可缓存前缀）
env + mode + iteration → reminder()  → 临时 user 消息（不落盘）
session.messages（真实历史）
        ↓
Provider.streamChat({ system/stable, messages: [...reminders, ...history], tools })
        ↓
usage(cache hit/miss) → token_usage 事件 → TUI/日志
```

与 spec：F1–F11→Prompt 层；F12→tools；F13–F15→reminder+loop；F16–F18→provider+events；F19→文档；F20→loop 接入。

## 核心数据结构

### PromptSectionId
`identity` | `constraints` | `task_mode` | `action` | `tools` | `tone` | `output` | `environment` | `custom_instructions` | `skills` | `memory`

### PromptSection
- `id: PromptSectionId`
- `priority: number` — 越小越靠前
- `title?: string`
- `content: string` — 空字符串表示本轮跳过该槽

### BuildPromptInput
- `workspaceRoot: string`
- `now: Date`
- `platform: string`
- `customInstructions?: string`
- `activeSkillsText?: string`
- `memoryText?: string`

### BuildPromptResult
- `stableSystem: string` — 仅固定七模块；字节级稳定
- `fullSystem: string` — stable + 环境 +（非空）可选三槽（调试用）
- `sections: PromptSection[]`

说明：发往 API 的 system 使用 `stableSystem`；环境信息由 reminder 注入。

### ReminderKind
`plan_full` | `plan_reinforce` | `plan_brief` | `environment` | `execute_brief`

### ReminderMessage
- `role: "user"`
- `content: string` — `<system-reminder>…</system-reminder>`
- `kind: ReminderKind`

### ReminderInput
- `mode: "plan" | "execute"`
- `iteration: number`
- `reinforceEvery: number` — 默认 `5`
- `environment: { workspaceRoot, timeLabel, platform }`

### PromptBuilder
- `build(input: BuildPromptInput): BuildPromptResult`

### ReminderBuilder
- `build(input: ReminderInput): ReminderMessage[]`
- 计划模式：第 1 轮 `plan_full`+`environment`；`iteration > 1 && iteration % reinforceEvery === 1` → `plan_reinforce`+`environment`；否则 `plan_brief`+`environment`
- 执行模式：仅 `environment`

### ChatRequest（扩展）
- 可选 `system?: string` — 优先作为稳定 system
- 可选 `cacheTools?: boolean` — Anthropic 对 tools 打缓存标记（默认 true）

### token_usage / CollectedTurn.usage（扩展）
```
{
  type: "token_usage";
  inputTokens?: number;
  outputTokens?: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  cacheAvailable: boolean;
}
```

### 常量
- 标签名：`system-reminder`
- `DEFAULT_REINFORCE_EVERY = 5`
- priority：identity=10 … output=70，environment=80，可选槽 90/100/110

## 模块设计

### Prompt 类型与拼装（`src/prompt/`）
**职责：** 按 priority 排序，跳过空 content，模块间 `\n\n` 拼接。  
**满足：** F1–F4、N3。

### 固定 / 可选模块文案（`src/prompt/sections.ts`）
**职责：** 七个固定模块中文正文；可选三槽本轮空。含标签语义与双重强化规则的全局侧。  
**满足：** F5–F10、F13、F3。

### 环境信息（`src/prompt/environment.ts`）
**职责：** 工作区、本地时间、platform 文本。  
**满足：** F11。

### Reminder（`src/prompt/reminder.ts`）
**职责：** 控频生成伪 user 消息。  
**满足：** F13–F15。

### 请求装配（`src/agent/loop.ts`）
**职责：** 每轮 `stableSystem` + reminders（不落盘）+ 历史 → `streamChat`。拼装失败则本轮报错停止。  
**满足：** F14、F20、N2、N4。

### 工具描述强化（`src/tools/*.ts`）
**职责：** description 追加「优先专用工具」「编辑前先读」等。  
**满足：** F12。

### OpenAI Provider
**职责：** system 置顶；解析 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`；流式若需则开 `stream_options.include_usage`。  
**满足：** F16、F18、N5、N6。

### Anthropic Provider
**职责：** system blocks + `cache_control: ephemeral`；tools 末项可打标记；映射 `cache_read_input_tokens` / `cache_creation_input_tokens`。  
**满足：** F17、F18。

### Collector / Agent 事件
**职责：** 收集 usage/cache 写入 `CollectedTurn` 并 yield。  
**满足：** F18。

### TUI
**职责：** 展示 cache 命中行或「不可用」；不展示 reminder 气泡。  
**满足：** F18、AC7、AC11。

### 对比场景文档
**文件：** `docs/04-system-prompt/eval-scenarios.md`（≥3 场景）。  
**满足：** F19。

## 模块交互

### 每轮 Agent 迭代
```
AgentLoop iteration=i
  → PromptBuilder.build → stableSystem
  → ReminderBuilder.build(mode, i, env) → reminderMsgs（不落盘）
  → Provider.streamChat({
        system: stableSystem,
        messages: [...reminderMsgs, ...session.messages],
        tools: filterToolsForMode(...),
     })
  → token_usage（含 cache*）
  → 仅落盘真实 user/assistant/tool
```

### 计划模式控频
| iteration | 提醒 |
|-----------|------|
| 1 | plan_full + environment |
| 2..5 | plan_brief + environment |
| 6 | plan_reinforce + environment |
| … | 同规则周期性加强 |

### 错误路径
拼装抛错 → 中文错误停止本轮，进程不崩；不静默空 system。

### 依赖方向
```
CLI → ChatService → AgentLoop → PromptBuilder / ReminderBuilder / Provider / SessionStore / Registry
Provider 不依赖 prompt 文案；Prompt 不依赖 TUI
```

## 文件组织

```
docs/04-system-prompt/
├── spec.md
├── plan.md
├── task.md
├── checklist.md
└── eval-scenarios.md

src/prompt/
├── types.ts
├── sections.ts
├── environment.ts
├── builder.ts
├── reminder.ts
└── index.ts

src/agent/loop.ts          — 接入
src/agent/collector.ts     — cache usage
src/agent/types.ts         — 事件扩展
src/provider/types.ts
src/provider/openai.ts
src/provider/anthropic.ts
src/tools/*.ts             — description
src/tui/chat-screen.tsx    — cache 展示
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 稳定 system vs 环境 | system 仅七固定模块；环境走 reminder | 前缀稳定，利于缓存 |
| 可选三槽 | 顺序保留，空则跳过 | 扩展点且无噪声 |
| Reminder | `<system-reminder>` 伪 user，不落盘 | 已选产品决策 |
| 计划控频 | 1 完整；`i>1 && i%5===1` 加强；其余短 | N=5 |
| 执行模式 | 每轮仅 environment | 避免模式文案刷屏 |
| 拼装失败 | 报错停止，不静默空 system | 可观测 |
| DeepSeek | 稳定前缀 + hit/miss 字段；必要时 `stream_options` | 可观测 |
| Anthropic | ephemeral cache_control；read/creation 映射 | 显式断点 |
| 无 cache 字段 | `cacheAvailable: false` | N5 |
| 双重强化 | sections + tool.description | F8/F9/F12 |
| 评估 | 仅 eval-scenarios.md | F19 |
| 配置 | 不新增 YAML | YAGNI |

## Spec 覆盖自检

| Spec | 归属 |
|------|------|
| F1–F4, F5–F10 | sections + builder |
| F11 | environment + reminder |
| F12 | tools/* |
| F13–F15 | reminder + sections |
| F14, F20 | agent/loop |
| F16–F18 | providers + collector + TUI |
| F19 | eval-scenarios.md |
| N2–N5 | 错误路径 + 稳定前缀 + cacheAvailable |
