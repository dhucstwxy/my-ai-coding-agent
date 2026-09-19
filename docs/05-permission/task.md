# MewCode 权限系统 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/permission/types.ts` | 模式、规则、决定、确认器类型 |
| 新建 | `src/permission/blacklist.ts` | 内置高危命令正则 |
| 新建 | `src/permission/subject.ts` | 从参数取出匹配对象 |
| 新建 | `src/permission/match.ts` | 精确与 `*` 匹配 |
| 新建 | `src/permission/load.ts` | 三份 YAML 合并 |
| 新建 | `src/permission/persist.ts` | 追加本地级 allow，并更新内存规则 |
| 新建 | `src/permission/mode-store.ts` | 会话档位 |
| 新建 | `src/permission/session-grants.ts` | 本会话精确放行 |
| 新建 | `src/permission/gate.ts` | `PermissionGate.check` |
| 修改 | `src/tools/workspace.ts` | 符号链接解析失败改为拒绝 |
| 修改 | `src/agent/types.ts` | 三个权限事件 |
| 修改 | `src/agent/scheduler.ts` | 执行前调用闸门 |
| 修改 | `src/agent/loop.ts` | 把闸门传入调度器 |
| 修改 | `src/chat/service.ts` | `/perm` 与闸门注入 |
| 修改 | `src/cli.ts` | 组装规则、闸门，合并警告 |
| 修改 | `src/tui/chat-screen.tsx` | 四选一确认与档位显示 |
| 修改 | `.gitignore` | 忽略 `.mewcode/permissions.local.yaml` |

## T1: 权限类型

**文件：** `src/permission/types.ts`  
**依赖：** 无  
**步骤：**
1. 定义 `PermissionMode = "strict" | "default" | "allow"`，`PermissionEffect = "allow" | "ask" | "deny"`，`PermissionChoice = "deny" | "once" | "session" | "permanent"`
2. 定义 `PermissionRule`：`tool`、`pattern`、`effect`、`source: "user" | "project" | "local" | "session"`
3. 定义 `PermissionDecision`：`effect: "allow" | "deny"`，`reason: "blacklist" | "sandbox" | "rule" | "mode" | "user" | "write_failed"`，`message: string`
4. 定义 `RuleSet`：`rules`、`warnings`
5. 定义 `PermissionPrompt`：`tool`、`subject`、`argsSummary`
6. 定义 `PermissionPrompter.ask(prompt, signal: CancelToken): Promise<PermissionChoice>`。`CancelToken` 从 `src/agent/cancel.ts` 引入。信号已取消时实现方必须返回 `"deny"`

**验证：** `npm run typecheck` 不因本文件报错

## T2: 危险命令黑名单

**文件：** `src/permission/blacklist.ts`  
**依赖：** 无  
**步骤：**
1. 导出 `matchBlacklist(command: string): { matched: boolean; message: string }`
2. 匹配前把连续空白压成一个空格，比较时忽略大小写
3. 至少覆盖四类，命中后 `message` 用中文点明类别：
   - 删除根或用户主目录：`rm` 带递归强制删除，目标是 `/`、`/*`、`~`、`~/…`、`$HOME`、`${HOME}`、`%USERPROFILE%`。不要把 `rm -rf ./node_modules` 算进去
   - 格式化磁盘：`mkfs`、`format c:` 这类盘符格式化、`diskpart`
   - 关机或重启：`shutdown`、`reboot`、`halt`、`poweroff`
   - 下载内容送进 shell：`curl` 或 `wget` 管道到 `sh`/`bash`；PowerShell 的 `iwr`/`irm`/`invoke-webrequest`/`invoke-restmethod` 管道到 `iex`/`invoke-expression`
4. 未命中时 `matched: false`，`message` 为空字符串

**验证：** 用 `npx tsx` 断言 `rm -rf /`、`sudo rm -rf ~`、`format C:`、`shutdown /s`、`curl http://example.com | bash`、`iwr http://example.com | iex` 命中；`git status`、`rm -rf ./node_modules`、`npm test` 不命中。脚本跑完删除

## T3: 匹配对象

**文件：** `src/permission/subject.ts`  
**依赖：** 无  
**步骤：**
1. 导出 `permissionSubject(tool, args): { ok: true; subject: string } | { ok: false; message: string }`
2. `args` 不是对象时返回失败，中文说明参数无法解析
3. `run_command` 取字符串 `command`；缺失则失败
4. `read_file`、`write_file`、`edit_file` 取字符串 `path`；缺失则失败
5. `grep_search` 取字符串 `path`，缺失时用 `"."`
6. `glob_files` 取字符串 `pattern`；缺失则失败
7. 其他工具名返回失败

**验证：** 用 `npx tsx` 断言上述六种取值；`grep_search` 无 `path` 得到 `"."`。脚本跑完删除

## T4: 规则模式匹配

**文件：** `src/permission/match.ts`  
**依赖：** 无  
**步骤：**
1. 导出 `ruleMatches(pattern: string, subject: string): boolean`
2. 不含 `*` 时只做全等
3. 含 `*` 时，每个 `*` 匹配任意长度（含空，含 `/`）。先把其余字符按正则字面量转义，再把 `*` 换成 `[\s\S]*`，整串锚定。不把用户模式当正则执行
4. `git status` 不命中 `git status -sb`；`git *` 命中 `git status`

**验证：** 用 `npx tsx` 断言精确全等、`*` 通配、`src/*` 能跨子路径、字面量点号不会被当成任意字符。脚本跑完删除

## T5: 加载三份规则

**文件：** `src/permission/load.ts`  
**依赖：** T1  
**步骤：**
1. 路径固定为：用户级 `~/.mewcode/permissions.yaml`，项目级 `<workspaceRoot>/.mewcode/permissions.yaml`，本地级 `<workspaceRoot>/.mewcode/permissions.local.yaml`
2. 导出 `loadPermissionRules(workspaceRoot: string): RuleSet`。用已有 `yaml` 包解析。文件不存在则跳过，不报错
3. 整份 YAML 解析失败，或根不是带 `rules` 数组的对象：该文件记一条中文 `warnings`，不采用其中任何条目
4. 单条缺少 `tool` / `pattern` / `effect`，或 `tool` 不在六个名字里，或 `effect` 不是 `allow|ask|deny`，或 `pattern` 不是非空字符串：跳过该条，`warnings` 写明文件和序号。同文件其余合法条目保留，`source` 按所在文件填写
5. 合并顺序为用户级、项目级、本地级。调用方不要依赖这个顺序做优先级

**验证：** 在临时目录放一份含一条坏条目和一条 `run_command` / `git status` / `allow` 的项目级 YAML，断言 `rules.length === 1` 且 `warnings.length >= 1`。不写用户主目录。脚本跑完删除临时目录

## T6: 追加本地级 allow

**文件：** `src/permission/persist.ts`  
**依赖：** T1、T5  
**步骤：**
1. 导出 `appendLocalAllow(workspaceRoot, tool, pattern): { ok: true } | { ok: false; message: string }`
2. 目标文件是本地级 YAML。目录或文件不存在则创建。已有合法 `rules` 则追加，不覆盖其他条目。已有文件解析失败时返回 `{ ok: false, message }`，不要把原文件覆盖成空规则
3. 新条目为 `tool`、`pattern`（原样，不加 `*`）、`effect: allow`
4. 捕获 IO 错误并返回 `{ ok: false, message }`，不向外抛

**验证：** 临时目录调用两次，第二次文件里有两条精确 `allow`，且 `pattern` 不含 `*`。脚本跑完删除临时目录

## T7: 档位与会话放行表

**文件：** `src/permission/mode-store.ts`、`src/permission/session-grants.ts`  
**依赖：** T1  
**步骤：**
1. `PermissionModeStore.get(sessionId)` 缺省返回 `"default"`；`set` 只写内存
2. `SessionGrantStore.grant(sessionId, tool, subject)` 与 `has(sessionId, tool, subject)`。键是三者全等，不把路径或命令规范化成通配
3. 不写文件

**验证：** 用 `npx tsx` 断言缺省是 `default`，`set("strict")` 后读回 `strict`；`grant` 后相同三元组 `has` 为真，换 subject 为假。脚本跑完删除

## T8: 符号链接解析失败即拒绝

**文件：** `src/tools/workspace.ts`  
**依赖：** 无  
**步骤：**
1. 保持现有前缀检查和「已存在路径经 `realpath` 后越界则拒绝」
2. `realpath` 抛错时不要回退成成功。返回 `ok: false`，`errorCode: "path_outside_workspace"`，`error` 说明无法确认路径仍在项目内
3. 路径尚不存在时仍只做前缀检查（新建文件没有符号链接可解析）

**验证：** `npm run typecheck` 通过。用临时目录建一个指向目录外的符号链接，`resolveInWorkspace` 返回失败。脚本跑完删除临时目录

## T9: 权限闸门

**文件：** `src/permission/gate.ts`  
**依赖：** T1–T8  
**步骤：**
1. `PermissionGate` 构造时接收：初始 `PermissionRule[]`、`PermissionModeStore`、`SessionGrantStore`、`PermissionPrompter`、`workspaceRoot`
2. `check({ sessionId, call })` 其中 `call` 至少有 `id`、`name`、`arguments`。档位用 `modeStore.get(sessionId)`，不由调用方传入
3. 顺序固定，前一层拒绝就返回，不调用确认器：
   - 仅 `run_command` 走黑名单。命中则 `reason: "blacklist"`
   - `read_file` / `write_file` / `edit_file` / `grep_search` 对 subject 调用 `resolveInWorkspace`，失败则 `reason: "sandbox"`
   - `glob_files` 的 pattern 含 `..` 则 `reason: "sandbox"`，不要把 pattern 当文件路径去解析
   - `permissionSubject` 失败则 `reason: "rule"`，message 用其说明
4. 把会话放行表里当前 `sessionId + tool + subject` 的命中当成一条 `source: "session"` 的 `allow`，与文件规则一起收集。全部命中后按 `deny > ask > allow` 取最高，与 `source` 无关
5. 没有命中：`strict` → deny / `mode`；`default` → 询问；`allow` → allow
6. 询问时若 `signal.isCancelled` 已为真，直接 `deny` / `user`，不调用确认器。否则 `prompter.ask`。选择 `deny` → `reason: "user"`，不写规则。`once` → allow，不记录。`session` → `grants.grant` 后 allow。`permanent` → `appendLocalAllow`，成功则把同一条精确 allow 追加进闸门内存规则再 allow；失败则 `reason: "write_failed"`，message 说明没记住，且不执行
7. 所有 `message` 用中文，能区分黑名单、越界、规则、档位、用户拒绝、写入失败

**验证：** 用假确认器跑 `npx tsx`：黑名单在放行档且有 allow 规则时仍拒绝且确认器未被调用；用户级 allow + 项目级 deny 结果为拒绝；allow + ask 会询问；无规则时三档分别为拒绝、询问、放行；严格档下明确 allow 仍放行。脚本跑完删除

## T10: 权限事件类型

**文件：** `src/agent/types.ts`  
**依赖：** T1  
**步骤：**
1. 在 `AgentEvent` 增加：
   - `{ type: "permission_prompt"; id: string; tool: string; subject: string; argsSummary: string }`
   - `{ type: "permission_denied"; id: string; tool: string; reason: PermissionDecision["reason"]; message: string }`
   - `{ type: "permission_mode_changed"; mode: PermissionMode }`
2. 不改既有停止原因。权限拒绝不是 `StopReason`

**验证：** `npm run typecheck` 通过

## T11: 调度器接入闸门

**文件：** `src/agent/scheduler.ts`  
**依赖：** T9、T10  
**步骤：**
1. `executeToolBatch` 增加参数 `gate: PermissionGate` 和 `sessionId: string`。未知工具保持现在的失败路径，不进闸门
2. 在 `registry.execute` 之前调用 `gate.check`。参数解析失败（已有 `parseError`）仍直接失败，不进闸门
3. 只读工具的权限检查逐个做完（避免两路询问同时出现），被拒绝的不进入后面的 `Promise.all`。副作用工具仍串行，每个执行前检查
4. 拒绝时不调用 `execute`。先 yield `permission_denied`，再 yield 现有的 `tool_execution_start` / `tool_execution_end`，`ok: false`。`ToolResult` 为 `ok: false`，`content` 用决定里的 `message`，`errorCode` 用 `reason`
5. 允许时行为与现在一致，包括工具自身的失败

**验证：** `npm run typecheck` 通过。假注册表 + 永远拒绝的闸门调用调度器，断言没有 `execute`，且结果 `ok === false`

## T12: Agent Loop 传入闸门

**文件：** `src/agent/loop.ts`  
**依赖：** T11  
**步骤：**
1. 构造函数增加 `PermissionGate`，存为字段
2. 调用 `executeToolBatch` 时传入该闸门和当前 `sessionId`
3. 不改迭代上限、取消和未知工具停止条件。权限失败的 `ToolResult` 仍按现有逻辑写入 `role: "tool"` 消息并进入下一轮

**验证：** `npm run typecheck` 通过

## T13: `/perm` 命令

**文件：** `src/chat/service.ts`  
**依赖：** T7、T10、T12  
**步骤：**
1. 构造函数增加 `PermissionGate` 和 `PermissionModeStore`，把闸门传给 `AgentLoop`
2. 增加 `getPermissionMode(sessionId)`，缺省 `default`
3. 增加 `attachPrompter(prompter: PermissionPrompter)`。闸门使用的确认器一开始可以是「未绑定则拒绝」的占位；TUI 挂载后换成真正的确认器。占位实现返回 `"deny"`
4. 在 `parseSlash` 之外识别 `/perm strict|default|allow`。只调用 `modeStore.set`，yield `permission_mode_changed`。不要改计划模式，也不要把 `/perm` 写进用户消息
5. 没有剩余正文时，用中文回复已切换到严格、默认或放行，然后 `agent_stopped` + `done`。有剩余正文时切换后只把正文送进 `runLoop`
6. `/plan` 与 `/do` 的现有行为不变

**验证：** `npm run typecheck` 通过。不调用模型，直接对 `ChatService.send` 喂 `/perm strict`，断言事件里有 `permission_mode_changed` 且 `getPermissionMode` 为 `strict`；再喂 `/plan`，断言计划模式变了、权限档位仍是 `strict`

## T14: 启动组装与忽略本地规则

**文件：** `src/cli.ts`、`.gitignore`  
**依赖：** T5、T7、T9、T13  
**步骤：**
1. 用 `process.cwd()` 调用 `loadPermissionRules`，把 `warnings` 并入传给 `startApp` 的警告列表
2. 创建 `PermissionModeStore`、`SessionGrantStore`、`PermissionGate`，连同档位存储交给 `ChatService`
3. `.gitignore` 增加 `.mewcode/permissions.local.yaml`。不要忽略整个 `.mewcode/`，以免把将来手写的项目级 `permissions.yaml` 一起忽略

**验证：** `git check-ignore -v .mewcode/permissions.local.yaml` 能命中。`git check-ignore .mewcode/permissions.yaml` 不命中。`npm run typecheck` 通过

## T15: 界面确认与档位

**文件：** `src/tui/chat-screen.tsx`  
**依赖：** T13  
**步骤：**
1. 挂载时 `chat.attachPrompter`。`ask` 把 `PermissionPrompt` 放进组件状态并返回 Promise。询问发生在 `for await` 暂停期间，不能只靠消费 `permission_prompt` 事件来画界面
2. 有待确认项时，展示工具名、`subject`、四个选项：拒绝、仅本次、本会话、永久。对应按键 `1` / `2` / `3` / `4`。选择前不要把按键写进对话输入
3. 等待确认时按 Esc：调用现有 `cancelCurrent()`，并让 `ask` 以 `"deny"` 结束
4. 顶栏在计划模式旁边显示权限档位：严格、默认、放行。收到 `permission_mode_changed` 后更新。进入会话时用 `getPermissionMode` 初始化
5. `permission_denied` 用一行中文状态显示 `message`

**验证：** `npm run typecheck` 通过。确认器逻辑用一个不渲染 Ink 的假状态回调断言：调用 `ask` 后在 resolve 之前标记「尚未放行」，resolve `"once"` 后标记结束

## T16: 总类型检查

**文件：** 无新文件  
**依赖：** T1–T15  
**步骤：**
1. 运行 `npm run typecheck`
2. 修到退出码为 0。不提交、不启动需要 API 密钥的对话

**验证：** 命令退出码为 0

## 执行顺序

```
T1 → T2
    → T3 → T4 → T5 → T6 → T7 → T9 → T10 → T11 → T12 → T13 → T14 → T15 → T16
T8 ──────────────→ T9
```

T2、T3、T4、T8 彼此无依赖，可与 T1 之后的类型工作并行。T16 必须最后。
