# 斜杠命令 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/commands/types.ts` | 类型与 UiPort |
| 新建 | `src/commands/registry.ts` | 注册与冲突检测 |
| 新建 | `src/commands/parse.ts` | 输入解析 |
| 新建 | `src/commands/dispatch.ts` | 分发 |
| 新建 | `src/commands/complete.ts` | Tab 补全 |
| 新建 | `src/commands/builtin/*.ts` | 十个命令 |
| 新建 | `src/commands/register-builtins.ts` | 批量注册 |
| 新建 | `src/commands/index.ts` | 导出 |
| 修改 | `src/chat/service.ts` | 接入 dispatch，删旧 parse* |
| 修改 | `src/tui/chat-screen.tsx` | UiPort、Tab、状态栏短标 |
| 修改 | `src/cli.ts` | 构建 registry，冲突 exit(1) |

## T1: 类型

**文件：** `src/commands/types.ts`  
**依赖：** 无  
**步骤：**
1. 定义 `CommandType`、`CommandDefinition`、`ParseResult`、`UiPort`、`StatusSnapshot`、`CommandContext`
2. handler 签名 `(ctx, args) => void | Promise<void>`

**验证：** `npm run typecheck`

## T2: Registry

**文件：** `src/commands/registry.ts`  
**依赖：** T1  
**步骤：**
1. `CommandRegistry.register(def)`：主名与每个 alias 写入同一 map；已存在则抛 `CommandConflictError`（含冲突名）
2. `get(name)`、`listVisible()`（过滤 hidden）、`allNames()`（含别名，供补全）

**验证：** `npx tsx` 注册两条同 alias 应抛错；正常 get/list 正确。脚本删

## T3: Parse

**文件：** `src/commands/parse.ts`  
**依赖：** T1  
**步骤：**
1. 空/纯空白 → `empty`
2. 非 `/` 开头 → `not_command`
3. `/Name rest` → `command{ name: name小写, args: rest }`；仅 `/name` 时 args 为空串

**验证：** 断言 `/HELP x`、`hello`、`` 三类结果。脚本删

## T4: Complete

**文件：** `src/commands/complete.ts`  
**依赖：** T2  
**步骤：**
1. 从 input 取出命令前缀（去掉前导 `/`，取第一段）
2. 在非 hidden 名称+别名中做 startsWith
3. 0 个 → candidates=[]；1 个 → single=`/name`；多个 → candidates 排序列表

**验证：** 注册 help/compact 后 `/h` 单匹配；`/c` 若仅 compact 则单匹配。脚本删

## T5: Dispatch

**文件：** `src/commands/dispatch.ts`  
**依赖：** T2、T3  
**步骤：**
1. `dispatch(raw, ctx, registry)`：empty 直接返回；not_command 返回 `{ handled:false, text }`；command 未命中返回 `{ handled:true, unknown:true, name }`；命中则 await handler，`{ handled:true }`

**验证：** 假 handler 被调用；unknown 不调用 handler。脚本删

## T6: Builtin — help / clear / session / memory / status

**文件：** `src/commands/builtin/{help,clear,session,memory,status}.ts`  
**依赖：** T1  
**步骤：**
1. help：listVisible 格式化输出 → showMessage
2. clear：clearScreen
3. session：从 ctx 打 ID/标题/条数/路径
4. memory：读 INDEX 路径与规模 → showMessage
5. status：getStatusSnapshot 格式化一屏

**验证：** 假 UiPort 断言调用次数与文案关键词。脚本删

## T7: Builtin — plan / do / permission / compact / review

**文件：** `src/commands/builtin/{plan,do,permission,compact,review}.ts`  
**依赖：** T1  
**步骤：**
1. plan/do：setAgentMode；无参 show 提示；有参 submitToAgent(rest)
2. permission：解析 strict|default|allow；非法则用法提示；合法 setPermissionMode；可选 rest 送 AI；别名在注册时挂 perm
3. compact：调用 ctx 提供的 runCompact(args)
4. review：submitToAgent(固定中文审查提示)

**验证：** 假 UiPort/假 compact 断言。脚本删

## T8: register-builtins + index

**文件：** `src/commands/register-builtins.ts`、`index.ts`  
**依赖：** T2、T6、T7  
**步骤：**
1. `buildDefaultRegistry(deps)` 注册全部十命令（permission 含 alias perm）
2. 导出 parse/dispatch/complete/registry 工厂

**验证：** typecheck；registry.get("perm") 与 get("permission") 同 def

## T9: ChatService 接入

**文件：** `src/chat/service.ts`  
**依赖：** T5、T8  
**步骤：**
1. 构造注入 registry 与构建 CommandContext 所需能力
2. send：dispatch；unknown → 本地文本反馈（可通过事件或返回约定）；not_command → runLoop；hit → 结束（handler 已执行）
3. 删除 parseCompact/parseSlash/parsePerm
4. 暴露 `runAgent(sessionId, text)` 供 UiPort.submitToAgent（内部 runLoop，不再 dispatch）
5. compact 仍走现有 pipeline 手动路径，改为供命令调用

**验证：** typecheck；tsx 打桩：`/status` 不调 provider；普通文本调 runLoop

## T10: TUI UiPort + 状态栏 + Tab

**文件：** `src/tui/chat-screen.tsx`  
**依赖：** T9  
**步骤：**
1. 顶栏改为 `[PLAN|DEFAULT · STRICT|DEFAULT|ALLOW]`
2. 实现清屏、showMessage（可用临时状态行或追加本地气泡，不写 store）
3. Tab：若 input 以 `/` 开头则 complete；单匹配改 input；多匹配 setCompletions 展示
4. Enter 逻辑保持 chat.send；斜杠不再乐观插入用户气泡（沿用/扩展 isSlashOnly：所有以 `/` 开头的输入）

**验证：** typecheck

## T11: CLI 冲突退出

**文件：** `src/cli.ts`  
**依赖：** T8、T9  
**步骤：**
1. buildDefaultRegistry；catch CommandConflictError → console.error → exit(1)
2. 把 registry 传入 ChatService

**验证：** typecheck；可选：临时双注册脚本断言 exit（不必改 cli）

## 执行顺序

```
T1 → T2 → T3 → T4
         ↘ T5
T1 → T6 ∥ T7 → T8 → T9 → T10 → T11
```

推荐串行：T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10 → T11。
