# MewCode 工具系统 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/tools/types.ts` | Tool、ToolResult、ToolDefinition、ToolContext |
| 新建 | `src/tools/truncate.ts` | 结果截断辅助（约 100k，标明已截断） |
| 新建 | `src/tools/workspace.ts` | 工作区路径解析与越界检查 |
| 新建 | `src/tools/registry.ts` | ToolRegistry（登记/查找/导出/执行包装） |
| 新建 | `src/tools/read-file.ts` | read_file |
| 新建 | `src/tools/write-file.ts` | write_file |
| 新建 | `src/tools/edit-file.ts` | edit_file（唯一匹配替换） |
| 新建 | `src/tools/run-command.ts` | run_command（超时、stdout/stderr/exitCode） |
| 新建 | `src/tools/glob-files.ts` | glob_files |
| 新建 | `src/tools/grep-search.ts` | grep_search |
| 新建 | `src/tools/create-registry.ts` | createDefaultRegistry 登记六个工具 |
| 修改 | `src/session/types.ts` | ChatMessage / ToolCallRecord 扩展 |
| 修改 | `src/provider/types.ts` | StreamEvent、ChatRequest 扩展 |
| 修改 | `src/provider/openai.ts` | tools 请求、历史映射、流式 tool_calls 解析 |
| 修改 | `src/provider/anthropic.ts` | tools 请求、历史映射、流式 tool_use 解析 |
| 修改 | `src/chat/service.ts` | 单次工具回合编排 + 摘要小函数 |
| 修改 | `src/cli.ts` | 注入 workspaceRoot 与 registry |
| 修改 | `src/tui/chat-screen.tsx` | 处理工具相关 StreamEvent，busy 覆盖整回合 |
| 修改 | `src/tui/message-list.tsx` | 渲染 tool 调用/结果块 |
| 可选修改 | `package.json` | 仅当 glob/grep 需要轻量依赖时 |

## T1: 工具类型与截断辅助

**文件：** `src/tools/types.ts`、`src/tools/truncate.ts`  
**依赖：** 无  
**步骤：**
1. 按 plan 定义 `ToolDefinition`、`ToolResult`、`ToolContext`、`Tool`
2. 实现 `truncateText(text, maxChars)`：超出时截断并追加中文「（已截断）」类标明

**验证：** `npx tsc --noEmit` 对上述文件无报错；对超长字符串调用 truncate 后长度受控且含截断标明

## T2: 工作区路径解析

**文件：** `src/tools/workspace.ts`  
**依赖：** T1  
**步骤：**
1. 实现 `resolveInWorkspace(root, userPath)`：相对路径相对 root；规范化（resolve）
2. 校验结果路径必须以 root 为前缀（注意 Windows 路径分隔与大小写）；越界返回 `{ ok: false, error, errorCode: "path_outside_workspace" }`
3. 能检测到的 symlink 逃逸则拒绝

**验证：** 用临时脚本：合法相对路径 ok；`../` 逃逸失败；绝对路径落在根外失败

## T3: ToolRegistry

**文件：** `src/tools/registry.ts`  
**依赖：** T1  
**步骤：**
1. 实现 `register` / `get` / `list` / `toDefinitions`
2. `execute(name, args, ctx)`：未知工具 → 结构化失败；对 `tool.execute` 包超时（`ctx.timeoutMs`）与 try/catch，异常/超时转为 `ToolResult`

**验证：** 注册一个假工具，`toDefinitions()` 含其 name；故意让 execute 抛错或超时，得到 `ok: false` 且进程不崩

## T4: read_file / write_file

**文件：** `src/tools/read-file.ts`、`src/tools/write-file.ts`  
**依赖：** T2  
**步骤：**
1. `read_file`：参数 `path`；经 workspace 解析；读 UTF-8；用 truncate；不存在 → `not_found`
2. `write_file`：参数 `path`、`content`；自动 `mkdir`；覆盖写入；越界失败
3. 参数缺失 → `invalid_args`，中文说明

**验证：** 在临时目录作 workspaceRoot：写入再读回内容一致；读不存在文件失败；写 `../x` 失败

## T5: edit_file

**文件：** `src/tools/edit-file.ts`  
**依赖：** T2、T4（复用读思路，可不依赖 write 实现）  
**步骤：**
1. 参数 `path`、`old_text`、`new_text`
2. 统计 `old_text` 字面量出现次数；0 → `edit_no_match`；>1 → `edit_multiple_matches`；均不写盘
3. 恰好 1 次则替换并写回

**验证：** 准备含两处相同片段的文件 → 多次匹配失败且文件未变；单处匹配成功内容更新

## T6: run_command

**文件：** `src/tools/run-command.ts`  
**依赖：** T1  
**步骤：**
1. 参数 `command`；`cwd = workspaceRoot`；`shell: true`
2. 捕获 stdout/stderr/exitCode；非零 → `ok: false`，content 含三者
3. 超时（默认 30s，可用 ctx.timeoutMs）杀进程 → `errorCode: "timeout"`

**验证：** 执行 `echo hello`（Windows 可用 `echo hello`）成功；执行必失败命令见非零；用极短 timeout + `sleep`/`timeout` 类命令验证超时返回

## T7: glob_files / grep_search

**文件：** `src/tools/glob-files.ts`、`src/tools/grep-search.ts`  
**依赖：** T2、T1（truncate）  
**步骤：**
1. `glob_files`：参数 `pattern`；仅工作区内；返回相对 root 的路径列表；条数过多截断并标明
2. `grep_search`：参数 `pattern`，可选 `path`/`glob`；返回路径+行号+片段；结果整体截断
3. 优先自研简单匹配；不够再加轻量依赖并更新 `package.json`

**验证：** 在含已知文件名/内容的临时目录：glob 能命中；grep 能命中行；越界 path 失败

## T8: createDefaultRegistry

**文件：** `src/tools/create-registry.ts`  
**依赖：** T3–T7  
**步骤：**
1. `createDefaultRegistry()` 登记六个工具：`read_file`、`write_file`、`edit_file`、`run_command`、`glob_files`、`grep_search`
2. `list()` 长度为 6，`toDefinitions()` 含全部 name

**验证：** 调用后 `registry.get("read_file")` 等均有定义；`toDefinitions().map(d => d.name)` 含六个名字

## T9: 会话消息类型扩展

**文件：** `src/session/types.ts`  
**依赖：** 无（可与 T1 并行）  
**步骤：**
1. `role` 增加 `"tool"`
2. 增加 `ToolCallRecord`；`ChatMessage` 增加可选 `toolCalls`、`toolCallId`、`toolName`、`isError`
3. 保持旧字段兼容，无需改 store 读写逻辑（JSON 原样落盘）

**验证：** `npx tsc --noEmit` 通过；构造含 tool 字段的消息对象可赋给 `ChatMessage`

## T10: Provider 类型扩展

**文件：** `src/provider/types.ts`  
**依赖：** T1（ToolDefinition）、T9（消息侧已扩展则可先做事件）  
**步骤：**
1. `ChatRequest` 增加可选 `tools?: ToolDefinition[]`
2. `StreamEvent` 增加 plan 中全部 `tool_call_*` / `tool_execution_*` / `tool_calls_ignored`（execution 事件由 ChatService 产出，类型仍放此处统一）

**验证：** `npx tsc --noEmit` 通过

## T11: OpenAI Provider 工具支持

**文件：** `src/provider/openai.ts`  
**依赖：** T10、T9  
**步骤：**
1. 请求体：有 `tools` 时转为 OpenAI function/tools 格式；`tool_choice` 按默认
2. 历史映射：assistant+`toolCalls` → `tool_calls`；`role:"tool"` → tool 消息（含 `tool_call_id`）
3. SSE：解析流式 `tool_calls` 增量，产出 `tool_call_start` / `tool_call_args_delta` / `tool_call_end`；结束时 `JSON.parse`，失败填 `parseError` 并保留原始字符串
4. 纯文本路径保持第一章行为

**验证：** 用 fixture 或真实 DeepSeek：请求带 tools 时事件流能出现完整 tool_call_end；无 tools 的纯文本仍正常

## T12: Anthropic Provider 工具支持

**文件：** `src/provider/anthropic.ts`  
**依赖：** T10、T9  
**步骤：**
1. 请求体带 Anthropic `tools`；历史映射 `tool_use` / `tool_result` content blocks
2. SSE 流式拼接 tool_use input → 统一 `tool_call_*` 事件
3. 与 thinking 并存时：思考事件仍映射，工具事件不丢

**验证：** 有 Anthropic 密钥时跑一次带 tools 的流；无密钥时至少用类型检查 + 对解析函数的 fixture 断言（若抽出解析逻辑）

## T13: ChatService 单次工具回合

**文件：** `src/chat/service.ts`  
**依赖：** T8、T9、T10、T11（OpenAI 路径先通即可；T12 可并行）  
**步骤：**
1. 构造函数增加 `ToolRegistry`、`workspaceRoot`
2. 实现 plan 中请求① → 只执行第一个 → 回灌 → 请求②（不带 tools）流程
3. 内联 `summarizeArgs` / `summarizeResult`（约 200 字）
4. 产出 `tool_execution_*`、`tool_calls_ignored`；参数 parseError 时不 execute，写失败 tool 消息
5. 请求②若再出 tool_call：不执行，附简短说明并结束
6. 无 tool call 时行为与第一章一致

**验证：** `npx tsc --noEmit` 通过；用临时 registry 假工具 + mock provider（若便于测）或真实 API：读文件后能落盘 tool 消息并有第二次文本

## T14: CLI 注入

**文件：** `src/cli.ts`  
**依赖：** T8、T13  
**步骤：**
1. `workspaceRoot = process.cwd()`
2. `createDefaultRegistry()` 注入 `ChatService`
3. 其余启动链路不变

**验证：** `npm start` 能进入 TUI（即使工具 UI 尚未完善也不应启动崩溃）

## T15: TUI 展示工具过程

**文件：** `src/tui/chat-screen.tsx`、`src/tui/message-list.tsx`  
**依赖：** T13、T14  
**步骤：**
1. chat-screen 处理新事件：工具执行中显示状态；结束后刷新 messages；busy 覆盖整回合（含第二次流式）
2. message-list 渲染 assistant.toolCalls 与 role=======tool 块：名称、参数/结果摘要、成功/失败
3. 纯文本回合展示与第一章一致

**验证：** 在 TUI 中让模型读一个项目内文件，界面可见工具名与结果摘要，随后流式文本；Esc/输入在 busy 时仍不可打断提交（与现有 busy 逻辑一致）

## T16: 类型检查与冒烟

**文件：** 无新增（全项目）  
**依赖：** T1–T15  
**步骤：**
1. 跑 `npm run typecheck`（或 `npx tsc --noEmit`）修完全部类型错误
2. 用 DeepSeek 做一次端到端：提问「读取 package.json 并总结」→ 工具执行 → 文本收尾
3. （可选）切换 Anthropic 配置复验工具链路

**验证：** typecheck 退出码 0；E2E 可见工具块 + 总结文本；重启后历史仍含 tool 相关记录

## 执行顺序

```
T1 → T2 → T4 → T5
        ↘
T1 → T3 ────────────→ T8 → T13 → T14 → T15 → T16
T1 → T6 ────────────↗
T1 → T2 → T7 ───────↗
T9 ─────────────────→ T10 → T11 ─↗
                         ↘ T12 ─↗（可与 T11 并行）
```

说明：T9 可与 T1–T8 并行；T11/T12 可并行；T13 至少依赖 OpenAI 路径（T11）与 Registry（T8）。
