# MewCode 权限系统 Plan

## 架构概览

在现有「对话命令 → Agent Loop → 工具调度」之上加一层权限闸门。工具真正执行前必须过闸；拒绝时返回结构化失败，循环继续。计划模式仍先过滤可用工具，权限判断发生在过滤之后。

| 组件 | 职责 |
|------|------|
| 黑名单 | 只检查 `run_command` 的命令文本。内置正则，命中即拒绝，配置和档位都不能放开 |
| 路径沙箱 | 对带路径的工具复用现有工作区解析：先解析符号链接，再做前缀判断。无法确认就拒绝 |
| 规则加载 | 读取用户级、项目级、本地级三份 YAML，合并成一个规则集合。格式坏的条目跳过并产生警告 |
| 规则匹配 | 用工具名加模式做精确或 glob 匹配。命中多条时，deny 优先于 ask，ask 优先于 allow |
| 档位 | 会话级严格、默认、放行。只在没有任何规则命中时决定拒绝、询问或放行 |
| 会话放行表 | 内存中的精确 allow。本会话放行写入这里，进程退出即失效 |
| 确认器 | 结果为询问时，向界面要一个选择：拒绝、仅本次、本会话、永久。永久选择追加一条精确 allow 到本地级 YAML |
| 调度接入 | 现有调度在调用工具前先过闸门。闸门拒绝则发出失败结果，不调用 `execute` |
| 界面 | 展示当前权限档位；收到询问事件后展示工具名和参数，并把选择交回确认器。既有取消仍能中止整轮任务 |

判断顺序：

```
工具调用
  → 黑名单
  → 路径沙箱
  → 合并规则（deny > ask > allow）
  → 无命中则看档位
  → 若为询问：等人选择
  → allow：执行工具
  → deny：结构化失败，回到 Agent Loop
```

## 核心数据结构

### PermissionMode

`"strict" | "default" | "allow"`。新会话为 `"default"`。

### PermissionEffect

`"allow" | "ask" | "deny"`。

### PermissionRule

- `tool: string`。六个工具名之一
- `pattern: string`。精确文本，或含 `*` 的 glob
- `effect: PermissionEffect`
- `source: "user" | "project" | "local" | "session"`。`session` 只存在于内存

### PermissionDecision

- `effect: "allow" | "deny"`。询问在闸门内部解决，对外只留下允许或拒绝
- `reason: "blacklist" | "sandbox" | "rule" | "mode" | "user" | "write_failed"`
- `message: string`。交给模型和界面的中文说明

### RuleSet

- `rules: PermissionRule[]`
- `warnings: string[]`。格式不合法条目的说明

### PermissionPrompt

- `tool: string`
- `subject: string`。命令文本或路径，也就是将要记住的精确参数
- `argsSummary: string`。界面展示用

### PermissionChoice

`"deny" | "once" | "session" | "permanent"`。

### PermissionPrompter

- `ask(prompt: PermissionPrompt, signal: CancelSignal): Promise<PermissionChoice>`
- 任务已取消时返回 `"deny"`，不再等待

### PermissionGate

- `check(call, ctx): Promise<PermissionDecision>`
- 内部顺序固定：黑名单、沙箱、规则、档位、必要时调用 `PermissionPrompter`
- `session` 放行写入内存表。`permanent` 追加本地级规则；写入失败时返回 `effect: "deny"`、`reason: "write_failed"`，并且不执行工具

### PermissionModeStore

- `get(sessionId): PermissionMode`。缺省 `"default"`
- `set(sessionId, mode): void`。只改内存

### 规则文件形状

三份文件结构相同：

```yaml
rules:
  - tool: run_command
    pattern: "git status"
    effect: allow
```

- 用户级：`~/.mewcode/permissions.yaml`
- 项目级：`./.mewcode/permissions.yaml`
- 本地级：`./.mewcode/permissions.local.yaml`。加入 `.gitignore`

### 匹配约定

- `run_command` 的匹配对象是参数 `command` 的原始字符串
- `read_file`、`write_file`、`edit_file`、`grep_search` 的匹配对象是参数 `path`。`grep_search` 没有 `path` 时用 `.`
- `glob_files` 的匹配对象是参数 `pattern`
- 精确规则要求字符串全等。glob 只把 `*` 当作通配

### 事件

- `{ type: "permission_prompt"; id; tool; subject; argsSummary }`
- `{ type: "permission_denied"; id; tool; reason; message }`
- `{ type: "permission_mode_changed"; mode }`

工具被拒绝时仍发出现有的 `tool_execution_end`，`ok: false`。

## 模块设计

### 类型（`src/permission/types.ts`）

**职责：** 定义 `PermissionMode`、`PermissionRule`、`PermissionDecision`、`PermissionPrompt`、`PermissionChoice`、`PermissionPrompter`。  
**对外接口：** 上述类型。  
**依赖：** 无。  
**满足：** F5、F8、F10。

### 黑名单（`src/permission/blacklist.ts`）

**职责：** 只接收命令字符串。内置正则覆盖删除根目录或用户主目录、格式化磁盘、关机或重启、下载内容送进 shell。大小写和多余空白不影响命中。  
**对外接口：** `matchBlacklist(command: string): { matched: boolean; message: string }`。  
**依赖：** 无。  
**满足：** F2、F13。

### 匹配对象（`src/permission/subject.ts`）

**职责：** 从工具参数取出本轮要匹配的字符串。`run_command` 取 `command`；读写改和 `grep_search` 取 `path`，`grep_search` 缺省为 `.`；`glob_files` 取 `pattern`。参数缺失时返回失败，由闸门拒绝。  
**对外接口：** `permissionSubject(tool, args): { ok: true; subject: string } | { ok: false; message: string }`。  
**依赖：** 无。  
**满足：** F4。

### 模式匹配（`src/permission/match.ts`）

**职责：** 精确规则全等才命中。含 `*` 时，每个 `*` 匹配任意长度，包括空。不使用完整正则语法。  
**对外接口：** `ruleMatches(pattern: string, subject: string): boolean`。  
**依赖：** 无。  
**满足：** F4、F7。

### 规则加载（`src/permission/load.ts`）

**职责：** 按用户级、项目级、本地级顺序读取 YAML。文件不存在视为空集合。单条缺字段或工具名不在六个之内则跳过，并写入 `warnings`。合法条目全部保留。  
**对外接口：** `loadPermissionRules(workspaceRoot: string): RuleSet`。  
**依赖：** 文件系统、YAML 解析。  
**满足：** F6、F16、N3。

### 本地规则追加（`src/permission/persist.ts`）

**职责：** 把一条精确 `allow` 追加到 `permissions.local.yaml`。文件不存在则创建。写入失败返回错误，不抛出到进程外。  
**对外接口：** `appendLocalAllow(workspaceRoot, tool, pattern): { ok: true } | { ok: false; message: string }`。  
**依赖：** 文件系统、YAML。  
**满足：** F11、N6。

### 档位与会话放行（`src/permission/mode-store.ts`、`src/permission/session-grants.ts`）

**职责：** 档位按会话存在内存，缺省 `default`。会话放行表保存 `sessionId + tool + subject`。  
**对外接口：** `PermissionModeStore.get/set`；`SessionGrantStore.grant/has`。  
**依赖：** 无。  
**满足：** F8、F9、F11。

### 闸门（`src/permission/gate.ts`）

**职责：** 实现 `PermissionGate.check`。顺序为黑名单、沙箱、合并规则、档位、询问。沙箱调用现有 `resolveInWorkspace`；`glob_files` 只拒绝包含 `..` 的模式。`once` 直接允许。`session` 写入会话放行表。`permanent` 先写本地文件，成功才允许。  
**对外接口：** `PermissionGate.check`。  
**依赖：** 黑名单、匹配对象、模式匹配、规则加载、本地追加、两个内存表、`PermissionPrompter`、工作区解析。  
**满足：** F1、F7、F8、F12、F13、F14。

### 调度接入（`src/agent/scheduler.ts`）

**职责：** 在 `registry.execute` 之前调用闸门。拒绝时不执行工具，仍发出 `tool_execution_start/end`，`ok: false`，并额外发出 `permission_denied`。  
**对外接口：** `executeToolBatch` 增加 `PermissionGate` 参数。  
**依赖：** `PermissionGate`。  
**满足：** F14、F15。

### 对话命令（`src/chat/service.ts`）

**职责：** 识别 `/perm strict`、`/perm default`、`/perm allow`。只改当前会话档位，不进入模型上下文。无任务正文时只回复已切换。与 `/plan`、`/do` 互不覆盖。  
**对外接口：** 现有 `send`。  
**依赖：** `PermissionModeStore`。  
**满足：** F9。

### 界面确认（`src/tui/chat-screen.tsx`）

**职责：** 实现 `PermissionPrompter`。收到询问后展示工具名、参数和四个选项，选择前不继续执行。按键返回选择。取消令牌触发时返回拒绝。顶栏显示当前权限档位。启动时展示规则警告。  
**对外接口：** `createTuiPrompter(...)`，由 CLI 注入。  
**依赖：** Ink 输入。  
**满足：** F10、N5。

## 模块交互

### 启动

1. CLI 用当前工作目录加载三份权限规则，收集警告
2. 创建档位存储、会话放行表和闸门。确认器由 TUI 提供，经 `ChatService` 传给 `AgentLoop`
3. 进入会话时档位为默认，顶栏同时显示计划模式和权限档位

### 切换档位

`/perm strict|default|allow` 只调用 `PermissionModeStore.set`。不写文件，不发给模型。界面收到 `permission_mode_changed` 后更新顶栏。

### 一次工具调用

```
调度器拿到工具调用
  → 闸门.check
      → run_command：黑名单
      → 带路径的工具：resolveInWorkspace
      → 会话放行表 + 三份规则
      → 多条命中：deny > ask > allow
      → 未命中：strict 拒绝 / default 询问 / allow 放行
      → 询问：prompter.ask
          拒绝：decision.deny，reason=user
          本次：decision.allow，不记录
          本会话：写入内存表后 allow
          永久：appendLocalAllow；失败则 deny，reason=write_failed
  → deny：不调用 execute，发 permission_denied 和失败的 tool_execution_end
  → allow：原样执行工具
结果写入对话历史，Agent Loop 继续
```

### 取消

确认器等待时若取消令牌已触发，立即返回拒绝，工具不执行，循环按既有取消路径停止。

### 依赖方向

```
CLI → TUI 确认器 → ChatService → AgentLoop → 调度器 → PermissionGate
PermissionGate → 黑名单 / 沙箱 / 规则加载 / 会话表 / 确认器
规则加载与本地追加不依赖 TUI 和 Agent Loop
```

## 文件组织

```
docs/05-permission/
├── spec.md
├── plan.md
├── task.md
└── checklist.md

src/permission/
├── types.ts            — 模式、规则、决定、确认器类型
├── blacklist.ts        — 内置高危命令正则
├── subject.ts          — 从参数取出匹配对象
├── match.ts            — 精确与 * 匹配
├── load.ts             — 三份 YAML 合并
├── persist.ts          — 追加本地级 allow
├── mode-store.ts       — 会话档位
├── session-grants.ts   — 本会话精确放行
└── gate.ts             — PermissionGate.check

src/agent/scheduler.ts  — 执行前调用闸门
src/agent/loop.ts       — 把闸门传入调度器
src/agent/types.ts      — 三个权限事件
src/chat/service.ts     — /perm 命令
src/cli.ts              — 组装闸门并注入
src/tui/chat-screen.tsx — 四选一确认与档位显示
.gitignore              — 忽略 .mewcode/permissions.local.yaml
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 闸门位置 | 调度器在 `execute` 之前调用 | 六个工具共用一条判断链，拒绝时不会执行到工具内部 |
| 计划模式 | 仍先过滤工具，再做权限判断 | 不改变第三章语义，权限是额外一层 |
| 黑名单 | 代码内置正则，不读配置 | 满足「不可被配置放开」 |
| 沙箱 | 复用现有 `resolveInWorkspace` | 已经做符号链接和前缀判断，避免两套路径规则 |
| 规则语法 | YAML 列表，模式只支持字面量和 `*` | 满足配置格式，又避免把规则当成正则执行 |
| 坏规则 | 跳过该条并警告，同文件合法规则保留 | 满足启动不崩溃，也满足合法规则仍生效 |
| 优先级 | 先收集全部命中，再按 deny、ask、allow 取最高 | 层级只影响写入位置，不影响结果 |
| 档位 | 内存、按会话、默认 `default` | 与 `/plan` 一样不落盘 |
| 永久放行 | 追加 `permissions.local.yaml`，并忽略该文件 | 只影响当前项目，不进版本库 |
| 写入失败 | 本次改为拒绝，不执行工具 | 避免界面说已永久记住、实际没写上 |
| 确认器 | 接口注入，闸门不依赖 Ink | TUI 负责按键，权限逻辑可以单独验证 |
| 拒绝结果 | `ToolResult.ok = false`，循环继续 | 模型能看到原因并改策略 |

## Spec 覆盖自检

| 需求 | 归属 |
|------|------|
| F1、F7、F8、F12、F13 | `gate.ts` |
| F2 | `blacklist.ts` |
| F3 | `gate.ts` + 现有工作区解析 |
| F4、F5 | `subject.ts`、`match.ts`、规则类型 |
| F6、F16 | `load.ts` |
| F9 | `mode-store.ts`、`chat/service.ts`、TUI |
| F10、N5 | TUI 确认器 |
| F11、N6 | `session-grants.ts`、`persist.ts` |
| F14、F15 | `scheduler.ts` |
| N2、N3 | 闸门返回失败，加载时跳过坏规则 |
| N7 | `resolveInWorkspace` 无法确认则拒绝 |
