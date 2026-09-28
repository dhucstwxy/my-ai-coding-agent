# Hook Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/hooks/types.ts` | 事件、规则、动作、致命错误 |
| 新建 | `src/hooks/load.ts` | 三份 YAML 校验与排序 |
| 新建 | `src/hooks/state.ts` | 注入文本与只跑一次 |
| 新建 | `src/hooks/actions.ts` | 四种动作 |
| 新建 | `src/hooks/engine.ts` | 匹配与按序执行 |
| 新建 | `src/hooks/index.ts` | 导出 |
| 修改 | `src/config/paths.ts` | 三份 hooks 路径 |
| 修改 | `.gitignore` | 忽略 `hooks.local.yaml` |
| 修改 | `src/prompt/types.ts` | `hookPrompt` |
| 修改 | `src/prompt/reminder.ts` | 提醒中插入注入段 |
| 修改 | `src/agent/scheduler.ts` | `pre_tool` / `post_tool` |
| 修改 | `src/agent/loop.ts` | 回合事件与提醒 |
| 修改 | `src/session/store.ts` | 消息事件 |
| 修改 | `src/context/pipeline.ts` | `compact` |
| 修改 | `src/chat/service.ts` | 回合边界 |
| 修改 | `src/tui/chat-screen.tsx` | 会话进入与离开 |
| 修改 | `src/cli.ts` | 启动校验，失败 exit(1) |

## T1: 类型

**文件：** `src/hooks/types.ts`  
**依赖：** 无  
**步骤：**
1. 定义九个 `HookEvent`、`HookAction`、`HookRule`、`HookDispatchInput`、`HookDispatchResult`
2. `HookFatalError` 带 `path` 与 `reason`，文案同时包含二者
3. `timeoutMs` 默认不写进类型必填；缺省由加载器填 `30000`

**验证：** `npm run typecheck`

## T2: 路径

**文件：** `src/config/paths.ts`、`.gitignore`  
**依赖：** 无  
**步骤：**
1. 增加用户级 `~/.mewcode/hooks.yaml`、项目级 `<cwd>/.mewcode/hooks.yaml`、本地级 `<cwd>/.mewcode/hooks.local.yaml`
2. `.gitignore` 增加 `.mewcode/hooks.local.yaml`

**验证：** `npm run typecheck`。临时调用三个函数，路径分别以 `hooks.yaml` 与 `hooks.local.yaml` 结尾

## T3: 加载与校验

**文件：** `src/hooks/load.ts`  
**依赖：** T1、T2  
**步骤：**
1. `loadHooks(workspaceRoot)` 按用户、项目、本地读取。文件不存在则跳过
2. 根字段 `hooks` 为数组。每条读 `event`、`if`、`deny`、`once`、`async`、`timeout_ms`、`action`
3. 不合法则抛 `HookFatalError`：未知事件、缺事件或动作、非工具事件写了 `if`、同时有 `all` 和 `any`、非 `pre_tool` 写了 `deny`、`timeout_ms` 不是正数、带 `deny` 或动作为 `prompt` 时 `async` 为真、动作缺命令 / 文本 / URL / 子 Agent 名字
4. `if` 省略表示无条件。`command` 的 `method` 省略为 `GET`。`id` 为 `文件路径#序号`
5. 返回的数组顺序是用户文件、项目文件、本地文件，文件内保持原序

**验证：** `npx tsx` 用临时目录：合法规则能加载；缺 `event` 抛错且消息含路径；三份各一条时顺序为 user、project、local。脚本删

## T4: 会话状态

**文件：** `src/hooks/state.ts`  
**依赖：** 无  
**步骤：**
1. 实现 `addPrompt`、`prompts`、`markOnce`、`hasOnce`、`clear`
2. `prompts` 把多条注入用空行拼接。没有注入时返回空串
3. `clear` 只清该会话

**验证：** 同一会话追加两段后 `prompts` 含两者。`clear` 后为空，且 `hasOnce` 为假。脚本删

## T5: 动作

**文件：** `src/hooks/actions.ts`  
**依赖：** T1、T4  
**步骤：**
1. `runAction(rule, sessionId, state, log, workspaceRoot)`
2. `command` 在 `workspaceRoot` 起子进程，收集 stdout/stderr，到时杀死。输出交给 `log`，不返回给调用方上下文
3. `http` 用 `fetch`，方法默认 GET。响应正文只交给 `log`
4. `prompt` 调用 `state.addPrompt`
5. `subagent` 写日志「尚未实现」并带上 `name`，不抛错
6. `background` 为真时，command 与 http 不阻塞返回。失败仍只记日志

**验证：** 注入后 `prompts` 含该文本。子 Agent 动作的日志含「尚未实现」和名字，且不抛错。脚本删

## T6: 引擎

**文件：** `src/hooks/engine.ts`、`src/hooks/index.ts`  
**依赖：** T3、T4、T5  
**步骤：**
1. `HookEngine` 持有规则列表、状态和 `log`
2. `dispatch` 按顺序处理。事件不符、条件不中、或 `hasOnce` 为真则整条跳过
3. 条件用 `ruleMatches`。`all` 要全部命中，`any` 要任一命中。工具事件没有 `subject` 时不命中、不拦截
4. 命中且 `once` 时先 `markOnce` 再 `runAction`。动作抛错只记日志
5. `pre_tool` 把本次执行过且带 `denyMessage` 的说明用换行拼进 `denyMessage`，并设 `blocked`。其它事件 `blocked` 为 `false`
6. `index.ts` 导出加载器、引擎、状态和错误类型

**验证：** 两条 `pre_tool` 都带拒绝说明时，结果含两段说明且顺序与加载顺序一致。第二条标记只跑一次后，再次 `dispatch` 不再包含它，也不再执行其动作。`git status` 不命中模式 `git status -sb`。脚本删

## T7: 提醒

**文件：** `src/prompt/types.ts`、`src/prompt/reminder.ts`  
**依赖：** 无  
**步骤：**
1. `ReminderInput` 增加可选 `hookPrompt`
2. 环境提醒顺序：已激活 Skill、Skill 目录、`hookPrompt`、原有环境信息
3. `hookPrompt` 为空时，输出与未传时一致

**验证：** 传入一段注入文本时，它位于 Skill 目录之后、工作区路径之前。脚本删

## T8: 工具拦截

**文件：** `src/agent/scheduler.ts`  
**依赖：** T6  
**步骤：**
1. `executeToolBatch` 增加可选 `hooks` 参数。未传时行为与现在相同
2. `guardCall` 在 `gate.check` 之前：能取出 `permissionSubject` 才 `dispatch(pre_tool)`
3. `blocked` 时返回失败工具结果，内容为拒绝说明，不调用闸门，不执行工具
4. 工具执行结束并得到结果后 `dispatch(post_tool)`，再把该结果交给原有写回路径

**验证：** 打桩闸门的 `check` 计数。命中拒绝说明时计数为 0，结果文本含拒绝说明。无拒绝说明时 `check` 仍被调用。脚本删

## T9: 回合与提醒接入

**文件：** `src/agent/loop.ts`  
**依赖：** T6、T7  
**步骤：**
1. 构造或运行参数可接收 `HookEngine` 与 `HookSessionState`。未传时不发 Hook
2. `run` 开始时 `dispatch(turn_start)`，`run` 的每条结束路径（完成、取消、出错、达到上限）都 `dispatch(turn_end)`
3. 拼 `buildReminders` 时传入 `state.prompts(sessionId)`

**验证：** `npm run typecheck`。打桩一轮，提醒文本含事先 `addPrompt` 的句子

## T10: 消息事件

**文件：** `src/session/store.ts`  
**依赖：** T6  
**步骤：**
1. `SessionStore` 增加可选监听器 `onMessage`。未设置时不发事件
2. `appendMessage` 成功后，`user` 发 `user_message`，`assistant` 发 `assistant_message`。`tool` 不发
3. 监听器抛错只记日志，不让 `appendMessage` 失败

**验证：** 写入一条 user 和一条 tool。监听器只收到 user。脚本删

## T11: 压缩事件

**文件：** `src/context/pipeline.ts`  
**依赖：** T6  
**步骤：**
1. 管线可接收可选的 `onCompact` 回调
2. 在现有 `compact_start` 发出的同一位置调用它。压缩继续与否仍由原逻辑决定
3. 未设置回调时行为不变

**验证：** `npm run typecheck`。手动跑一次会触发压缩的管线，回调收到 `compact`

## T12: 回合边界

**文件：** `src/chat/service.ts`  
**依赖：** T9  
**步骤：**
1. 持有引擎和状态，并传给 `AgentLoop` 与调度器
2. 只有即将调用 `runLoop` 的路径发回合事件：普通文本、共享 Skill、`/plan` 与 `/do` 带正文并进入循环的情况
3. `/help`、`/clear`、`/status` 以及只切换模式、不进入循环的命令不发 `turn_start`
4. `turn_end` 由 T9 的 `run` 结束路径发出，服务层不再重复发一次

**验证：** 打桩引擎。`/help` 的事件列表没有 `turn_start`。普通文本有且仅有一对 `turn_start` / `turn_end`

## T13: 会话进出

**文件：** `src/tui/chat-screen.tsx`、`src/cli.ts`  
**依赖：** T3、T6、T12  
**步骤：**
1. `cli` 在工具表就绪后 `loadHooks`。捕获 `HookFatalError` 时打印 `message` 并 `exit(1)`
2. 把引擎和状态传入界面与 `ChatService`
3. 聊天界面挂载时 `dispatch(session_start)`。`onBack` 时先 `dispatch(session_end)` 再 `state.clear(sessionId)`
4. 进程退出信号里对当前会话同样发 `session_end` 并 `clear`。没有当前会话时跳过

**验证：** `npm run typecheck`。临时把一份缺 `event` 的项目级 hooks 放进加载路径，退出码为 1 且输出含该文件路径。测完删除该文件

## 执行顺序

```
T1 → T3 → T6 → T8 → T12 → T13
T2 ↗      ↗
T4 → T5 ↗
T7 → T9 ↗
T10、T11 可在 T6 之后并行，于 T13 前完成
```

推荐串行：T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10 → T11 → T12 → T13。
