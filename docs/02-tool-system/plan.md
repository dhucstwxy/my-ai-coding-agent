# MewCode 工具系统 Plan

## 架构概览

在第一章「配置 → 会话 → Provider → TUI」之上，增加 **Tool 层**，并由 **ChatService** 负责「单次工具回合」编排（不做多步 Loop）。

| 组件 | 职责 |
|------|------|
| **Tool 抽象与注册中心** | 统一工具元信息与 `execute`；登记 / 按名查找 / 导出 API 工具列表 |
| **工作区路径工具** | 以启动时 `cwd` 为根，规范化路径并拒绝越界 |
| **六个内置工具** | 读 / 写 / 改文件、执行命令、glob 找文件、搜内容；统一超时与结构化结果 |
| **Provider（扩展）** | `ChatRequest` 可带 tools；流式产出 `tool_call_*` 事件；能把历史中的 tool 消息编进协议请求 |
| **对话编排（扩展）** | 第一次请求带 tools → 只执行第一个 tool call → 回灌历史 → 第二次不带 tools 收文本 |
| **会话存储（扩展）** | 持久化含 tool 调用与结果的消息，重启可回看 |
| **TUI（扩展）** | 展示工具名、参数摘要、执行状态与结果摘要；文本仍流式 |

数据流（含工具的一轮）：

```
用户输入 → ChatService
            ├─ 请求①（带 tools）→ Provider 流
            │     text_delta / tool_call_* / done
            ├─ 只执行第一个工具 → ToolRegistry.execute
            ├─ 落盘：assistant(tool_use) + tool_result
            ├─ 请求②（不带 tools）→ Provider 流 → text_delta
            └─ 落盘：assistant(text)
       → 同一 StreamEvent 流 → TUI
```

与 spec 对应：F1–F10→Tool 层；F11/F15→Provider；F12–F14→ChatService；F16→TUI；F17→保持纯文本路径。

## 核心数据结构

### ToolDefinition（API 可导出形态）
- `name: string`
- `description: string`
- `inputSchema: object` — JSON Schema（object 类型），供模型理解参数

### ToolResult
- `ok: boolean`
- `content: string` — 给模型看的文本结果（失败时为错误说明；过大时已截断并标明）
- `errorCode?: string` — 如 `path_outside_workspace` / `timeout` / `not_found` / `edit_no_match` / `edit_multiple_matches` / `invalid_args` / `parse_error`

### ToolContext
- `workspaceRoot: string` — 启动时 cwd 的绝对路径
- `timeoutMs: number` — 本工具执行超时

### Tool（统一接口，F1）
- `name: string`
- `description: string`
- `inputSchema: object`
- `execute(args: unknown, ctx: ToolContext): Promise<ToolResult>`

### ToolRegistry
- `register(tool: Tool): void`
- `get(name: string): Tool | undefined`
- `list(): Tool[]`
- `toDefinitions(): ToolDefinition[]` — 供 Provider 请求体使用
- `execute(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult>` — 查找 + 包装超时/异常为结构化失败

### 工具名约定（六个内置）

| name | 用途 |
|------|------|
| `read_file` | 读文件 |
| `write_file` | 写文件 |
| `edit_file` | 唯一匹配替换 |
| `run_command` | 执行命令 |
| `glob_files` | 按模式找文件 |
| `grep_search` | 搜代码内容 |

### ChatMessage（扩展，兼容旧会话）
- 保留：`id`、`role`、`content`、`thinkingSummary?`、`createdAt`
- `role` 扩展：`"user" | "assistant" | "system" | "tool"`
- `toolCalls?: ToolCallRecord[]` — 助手消息上的工具调用（可记录模型给出的完整列表，便于展示「忽略了后续」）
- `toolCallId?: string` — `role === "tool"` 时关联的调用 id
- `toolName?: string` — tool 结果消息上的工具名
- `isError?: boolean` — tool 结果是否失败

### ToolCallRecord
- `id: string`
- `name: string`
- `arguments: Record<string, unknown> | string` — 解析成功为对象；解析失败可保留原始字符串
- `ignored?: boolean` — 非第一个时为 true

### StreamEvent（扩展）
- 保留：`text_delta` / `thinking_*` / `error` / `done`
- 新增：
  - `{ type: "tool_call_start"; id: string; name: string }`
  - `{ type: "tool_call_args_delta"; id: string; delta: string }` — 参数 JSON 碎片
  - `{ type: "tool_call_end"; id: string; name: string; arguments: Record<string, unknown> | string; parseError?: string }`
  - `{ type: "tool_execution_start"; id: string; name: string; argsSummary: string }`
  - `{ type: "tool_execution_end"; id: string; name: string; ok: boolean; resultSummary: string }`
  - `{ type: "tool_calls_ignored"; names: string[] }` — 同回合被忽略的后续工具

### ChatRequest（扩展）
- 保留：`messages`、`model`、`thinking?`
- `tools?: ToolDefinition[]` — 缺省或空 = 不提供工具（第二次请求用）

### ChatProvider
- 签名不变：`streamChat(request: ChatRequest): AsyncIterable<StreamEvent>`
- 实现侧：有 `tools` 时写入协议请求体；能把历史中的 `toolCalls` / `role:"tool"` 编成各协议格式；流式拼参数并产出 `tool_call_*`

### ChatService
- `send(sessionId, userText): AsyncIterable<StreamEvent>` 行为扩展为单次工具回合编排
- 构造时注入：`SessionStore`、`ChatProvider`、`ProviderConfig`、`ToolRegistry`、`workspaceRoot`
- `argsSummary` / `resultSummary` 由 ChatService 内小函数生成（不单独建 `summary.ts`）

### 常量（本轮默认）
- 命令默认超时：`30_000` ms
- 读/搜等结果默认上限：约 `100_000` 字符（超出截断并标注）
- 参数摘要 / 结果摘要供 TUI：各截断到约 200 字符

## 模块设计

### Tool 核心（`src/tools/`）
**职责：** `Tool` / `ToolResult` / `ToolRegistry`；`createDefaultRegistry()` 登记六个内置工具。  
**对外接口：** `ToolRegistry`、`toDefinitions()`、`execute()`。  
**依赖：** 工作区路径工具；各具体工具实现。  
**满足：** F1、F2、F9。

### 工作区路径（`src/tools/workspace.ts`）
**职责：** 以 `workspaceRoot` 解析相对/绝对路径；规范化后校验仍落在根内；越界返回失败用错误码。  
**对外接口：** `resolveInWorkspace(root, userPath): { ok, absPath } | { ok:false, error }`。  
**满足：** F10、N5。

### 六个内置工具

| 模块 | 行为要点 |
|------|----------|
| `read_file` | 参数 `path`；读 UTF-8 文本；过大截断并标明；不存在/越界 → 结构化失败 |
| `write_file` | 参数 `path`、`content`；`mkdir` 中间目录；覆盖写入；越界失败 |
| `edit_file` | 参数 `path`、`old_text`、`new_text`；统计 `old_text` 出现次数；≠1 则 `edit_no_match` / `edit_multiple_matches`，不写盘 |
| `run_command` | 参数 `command`；在 `workspaceRoot` 下用 shell 执行；捕获 stdout/stderr/exitCode；超时杀进程；非零退出 `ok: false`，content 含 stdout/stderr/code |
| `glob_files` | 参数 `pattern`；仅工作区内匹配；返回路径列表（相对根，可截断条数） |
| `grep_search` | 参数 `pattern`，可选 `path`/`glob`；文本或正则搜索；返回路径+行号+片段；规模截断 |

**满足：** F3–F8、N3、N4。

### Provider 扩展（`src/provider/`）
**职责：**
- `ChatRequest.tools` → OpenAI `tools` / Anthropic `tools`
- 历史消息映射：assistant+`toolCalls`、`role:"tool"` → 各协议 tool 消息格式
- SSE 解析：拼 `arguments` 碎片 → `tool_call_start/args_delta/end`；`parseError` 时 arguments 保留原始串

**对外接口：** 仍为 `ChatProvider.streamChat`。  
**满足：** F11、F15、N6。

### 对话编排扩展（`src/chat/service.ts`）
**职责（单次工具回合）：**
1. 落盘 user 消息
2. 请求①：`tools = registry.toDefinitions()`，透传流事件；收集文本 + 全部 `tool_call_end`
3. 若无 tool call → 与第一章相同，落盘 assistant 文本，`done`
4. 若有 tool call → 只取第一个；对其余发 `tool_calls_ignored`；落盘 assistant（含 `toolCalls`，后续标 `ignored`）
5. `tool_execution_start` → `registry.execute` → `tool_execution_end`；落盘 `role:"tool"` 结果（参数解析失败则直接结构化失败、不调用工具）
6. 请求②：`tools` 省略；若仍出现 tool_call → 不执行，可 yield 简短说明并结束；只落盘文本 assistant
7. `done`

**满足：** F12–F14、F17。

### 会话存储（`src/session/`）
**职责：** 类型扩展后原样 JSON 落盘/加载；旧会话无新字段仍可读。  
**满足：** N7。

### TUI（`src/tui/`）
**职责：** 订阅新 `StreamEvent`；消息列表展示 tool 调用块（名、参数摘要、成功/失败、结果摘要）及 `role:"tool"`；流式正文逻辑不变；busy 期间覆盖整个「工具+二次回复」。  
**满足：** F16。

### 入口 CLI（`src/cli.ts`）
**职责：** `workspaceRoot = process.cwd()`；`createDefaultRegistry()`；注入 `ChatService`。  
**配置模块：** 本轮不新增 YAML 字段。

## 模块交互

### 启动链路（相对第一章的增量）
1. CLI → 加载配置 → 创建 Provider / SessionStore
2. `workspaceRoot = process.cwd()`，`registry = createDefaultRegistry()`
3. `ChatService(store, provider, config, registry, workspaceRoot)` → TUI

### 纯文本回合（无 tool call）
与第一章相同：请求①带 tools，模型只回文本 → 落盘 assistant → `done`。TUI 只见流式正文。

### 含工具回合（主路径）

```
TUI 提交
  → ChatService.send
      → append user
      → Provider.streamChat(messages, tools=全部定义)     // 请求①
          ← text_delta* / tool_call_* / done
      → 若多个 tool_call：只留第一个；yield tool_calls_ignored
      → append assistant{ content, toolCalls }
      → yield tool_execution_start
      → registry.execute(name, args, ctx)
      → yield tool_execution_end
      → append tool{ toolCallId, content, isError }
      → Provider.streamChat(messages, tools=undefined)   // 请求②
          ← text_delta* （若出现 tool_call_* 则忽略/不执行并结束）
      → append assistant{ content }
      → done
  ← 事件流
TUI：工具块 + 流式收尾文本
```

### 错误路径

| 场景 | 行为 |
|------|------|
| 路径越界 / 文件不存在 / 编辑匹配异常 | `ToolResult.ok=false` → 回灌 → 请求② 仍可生成说明 |
| 命令超时 | 杀进程 → 超时失败结果回灌 |
| 参数 JSON 解析失败 | 不调用 `execute`；构造失败 tool 结果回灌 |
| 请求①/② 网络或 API 错误 | `StreamEvent.error`；已执行的工具结果仍保留在历史 |
| 请求② 又想调工具 | 不执行；本轮结束（可附简短说明） |

### 依赖方向（无环）

```
CLI → TUI → ChatService → Provider / SessionStore / ToolRegistry
ToolRegistry → 各 Tool → workspace 路径工具
Provider 不依赖 Tool 实现（只吃 ToolDefinition[]）
ChatService 不依赖 TUI
```

## 文件组织

```
docs/02-tool-system/
├── spec.md
├── plan.md
├── task.md
└── checklist.md

src/
├── tools/
│   ├── types.ts           — Tool、ToolResult、ToolDefinition、ToolContext
│   ├── registry.ts        — ToolRegistry
│   ├── workspace.ts       — 路径解析与越界检查
│   ├── truncate.ts        — 结果截断辅助
│   ├── create-registry.ts — createDefaultRegistry
│   ├── read-file.ts
│   ├── write-file.ts
│   ├── edit-file.ts
│   ├── run-command.ts
│   ├── glob-files.ts
│   └── grep-search.ts
├── provider/
│   ├── types.ts           — 扩展 StreamEvent、ChatRequest
│   ├── openai.ts          — tools + 流式 tool_calls + 历史映射
│   └── anthropic.ts       — 同上（Messages tool_use / tool_result）
├── session/types.ts       — ChatMessage 扩展
├── chat/service.ts        — 单次工具回合编排；内含 args/result 摘要小函数
├── cli.ts                 — 注入 registry + workspaceRoot
└── tui/
    ├── chat-screen.tsx    — 处理新事件、busy 覆盖整回合
    └── message-list.tsx   — 渲染 tool 调用/结果块
```

本轮**不改**配置 schema；**可小改** `package.json` 若 glob/grep 需要轻量依赖（优先 Node 内置 + 自研简单匹配；不够再用成熟小库）。  
不单独新建 `src/tools/summary.ts`。

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 编排位置 | ChatService 内「单次工具回合」，不抽 Agent Loop | 对齐「Loop 留下一章」；下章改循环即可 |
| 多 tool call | 只执行第一个，其余 `ignored` + 事件通知 | 满足 F12，实现简单 |
| 第二次请求 | 不传 `tools` | 满足 F13/F14，比靠提示词禁止更硬 |
| 工作区根 | `process.cwd()` 启动时固定 | 满足 F10；不做可配置根 |
| 路径安全 | resolve + 前缀校验；能检测到的 symlink 逃逸拒绝 | 满足 N5 |
| Shell | `child_process` + `shell: true`，cwd=工作区，超时杀进程；不经确认 | 满足 F6；跨平台用平台默认 shell |
| 命令非零退出 | `ok: false`，content 含 stdout/stderr/exitCode | 模型易感知失败并调整 |
| 改文件 | 字面量唯一匹配（非正则） | 满足 F5，行为可预期 |
| glob / grep | 优先自研或 Node 能力；必要时再加轻量依赖 | 少依赖；行为可控 |
| 结果截断 | ~100k 字符，标明已截断 | 满足 N4 |
| 默认超时 | 命令 30s；Registry 统一包装 | 满足 N3 |
| 双协议 tools | OpenAI `tools`/`tool_calls`；Anthropic `tools`/`tool_use`/`tool_result` | 满足 F15 |
| 流式参数 | 增量拼接，结束时 `JSON.parse`；失败带 `parseError` | 满足 N6 |
| 会话兼容 | 新字段可选；旧 JSON 仍可加载 | 满足 N7、不破坏第一章数据 |
| UI 摘要 | ChatService 内小函数截断 ~200 字 | 调用点单一，避免多文件 |
| 验收默认 | DeepSeek（OpenAI 兼容）；Anthropic 有密钥再验 | 与第一章一致 |

## Spec 覆盖自检

| Spec | 归属 |
|------|------|
| F1/F2 | tools/types + registry |
| F3–F8 | 六个工具模块 + workspace |
| F9 | registry.execute 超时/异常包装 |
| F10/N5 | workspace.ts |
| F11/F15/N6 | openai.ts / anthropic.ts |
| F12–F14 | chat/service.ts |
| F16 | tui chat-screen / message-list |
| F17 | service 无 tool call 分支 |
| N3/N4 | timeout + truncate |
| N7 | session 类型扩展落盘 |
| N2/N9 | 结构化中文错误与注释 |
