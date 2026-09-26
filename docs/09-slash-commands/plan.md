# 斜杠命令 Plan

## 架构概览

把散落在 ChatService.send 的解析，收成 commands 层；TUI 只实现控制端口与补全交互。

| 组件 | 职责 |
|------|------|
| **CommandRegistry** | 登记元数据与 handler；启动检测主名/别名冲突并抛错（cli 捕获后 process.exit(1)） |
| **parseCommand** | `/` 识别、名/参拆分、小写化；空输入 / 非命令 / 未命中三种结果 |
| **CommandContext + UiPort** | handler 拿到的会话上下文 + 界面能力 |
| **builtin commands** | 十个内置命令各自一个注册模块 |
| **Dispatcher** | dispatch(raw, ctx)：解析 → 查找 → 执行 |
| **TabComplete** | 基于 registry 前缀匹配；单/多候选 |
| **ChatService** | 去掉旧 parse*；send 先 dispatch，非命令才 runLoop |
| **chat-screen** | Enter 走 chat.send；Tab 调补全；实现 UiPort；顶栏 [DEFAULT|PLAN · …] |

数据流：

```
回车 → parseCommand
  ├ 非 / 前缀 → AgentLoop
  ├ 未命中 → ui.show(引导 /help)
  └ 命中 → handler(ctx, args)
```

## 核心数据结构

### CommandType
`"local" | "ui" | "prompt"`

### CommandDefinition
- `name`, `aliases?`, `description`, `usage`, `type`
- `argsHint?`, `hidden?`, `handler(ctx, args)`

### ParseResult
- `empty` | `not_command` | `command{ name, args }`

### UiPort
- `showMessage`, `clearScreen`, `submitToAgent`
- `setAgentMode`, `setPermissionMode`, `getStatusSnapshot`

### StatusSnapshot
- agentMode, permissionMode, sessionId/title/messageCount/path
- tokenUsage?, compactCircuitOpen?

### CommandContext
- sessionId, workspaceRoot, ui, 以及 compact/session/memory 所需窄依赖

### Completions
- `complete(prefix) → { single?, candidates }`（排除 hidden）

## 模块设计

### commands/types.ts
类型与接口定义。

### commands/registry.ts
register / get / listVisible；冲突抛 CommandConflictError。

### commands/parse.ts
parseInput(raw)。

### commands/dispatch.ts
dispatch(raw, ctx, registry)。

### commands/complete.ts
complete(input, registry)。

### commands/builtin/*.ts + register-builtins.ts
十命令；registerBuiltins(registry, deps)。

### 挂载点
- chat/service.ts：持有 registry；send 先 dispatch
- tui/chat-screen.tsx：UiPort + Tab + 英文短标
- cli.ts：buildDefaultRegistry；冲突 exit(1)

## 模块交互

### 启动
cli → buildDefaultRegistry → 冲突则 exit(1) → ChatService(registry) → TUI

### 回车
Enter → chat.send → dispatch
  - not_command → runLoop
  - unknown → showMessage 引导 /help
  - hit → handler；若需 AI 则 ui.submitToAgent（绕过二次解析）

### Tab
Tab（input 以 / 开头）→ complete → 单匹配补全 / 多匹配列候选

### /clear
仅 ui.clearScreen，不改 JSONL

### 状态栏
mode/permission 事件 → [PLAN|DEFAULT · STRICT|DEFAULT|ALLOW]

## 文件组织

```
src/commands/
├── types.ts
├── registry.ts
├── parse.ts
├── dispatch.ts
├── complete.ts
├── register-builtins.ts
├── builtin/{help,compact,clear,plan,do,session,memory,permission,status,review}.ts
└── index.ts

修改：src/chat/service.ts, src/tui/chat-screen.tsx, src/cli.ts
docs/09-slash-commands/{spec,plan}.md
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 冲突失败 | 抛错 + exit(1) | 启动即失败 |
| UiPort 宿主 | chat-screen + ChatService 桥接 | 命令不依赖 Ink |
| showMessage | 默认不写 JSONL | 本地反馈不污染历史 |
| submitToAgent | 绕过二次解析 | 避免误伤 |
| /perm | permission 的别名 | 兼容旧习惯 |
| 多候选 Tab | 展示列表 | 本步不做方向键菜单 |
| 旧 parse* | 删除 | 单一入口 |

## Spec 覆盖

| F | 归属 |
|---|------|
| F1–F2 | registry + cli |
| F3–F5 | parse + dispatch + service |
| F6–F7 | UiPort + chat-screen |
| F8 | complete + Tab |
| F9–F18 | builtin/* |
