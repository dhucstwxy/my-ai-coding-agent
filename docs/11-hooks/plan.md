# Hook Plan

## 架构概览

Hook 收成独立一层。会话进出、回合起止、消息落盘、工具执行和压缩开始只负责发出事件，不自己读 YAML。

| 组件 | 职责 |
|------|------|
| **HookLoader** | 读取用户级、项目级、本地级三份声明。文件不存在当作空。按这个顺序拼成一份规则列表。任一文件里有一条不合法规则，抛出致命错误，启动时退出。 |
| **HookEngine** | 按事件取出命中的规则，跳过本会话已经跑过的「只跑一次」规则，按列表顺序执行动作。`pre_tool` 若有命中的拒绝说明，返回拦截结果，调用方不再进入权限闸门。动作失败只记日志。 |
| **条件匹配** | 复用现有权限的工具参数提取和 glob 匹配。一条规则内的多条条件按「全部满足」或「任一满足」判断。非工具事件不允许带条件。 |
| **动作执行** | shell 与 HTTP 在工作区或网络上执行，输出只写日志，可后台运行，受超时限制。注入提示词写入该会话的内存列表。子 Agent 只写一条「尚未实现」日志。 |
| **会话侧状态** | 进程内按会话保存已注入的提示词，以及已经执行过的「只跑一次」规则。离开会话或进程退出时清掉。不写 JSONL。 |
| **提示词** | 环境提醒在 Skill 目录之后、原有环境信息之前，附上本会话已注入的提示词。稳定系统前缀不放这些文字。 |

数据流：

```
启动
  → HookLoader 校验三份 YAML
  → 不合法则 exit(1)

进入会话 → session_start
离开会话或进程退出 → session_end，并清空该会话的注入与只跑一次标记

回车
  → 本地命令：不发回合事件
  → 进入对话循环：turn_start
       用户消息落盘 → user_message
       每轮模型请求的提醒 = 已激活 Skill + Skill 目录 + 注入提示词 + 环境信息
       助手消息落盘 → assistant_message
       工具调用：
         pre_tool → 若拦截，把拒绝说明当作工具结果，跳过权限与执行
         否则进入现有权限闸门
         执行结束后 post_tool
       压缩开始 → compact
  → 任务停止：turn_end
```

## 核心数据结构

### HookEvent

`"session_start" | "session_end" | "turn_start" | "turn_end" | "user_message" | "assistant_message" | "pre_tool" | "post_tool" | "compact"`

### HookRule

加载并校验通过后的一条规则。

- `id`：在本次进程内稳定。用来源文件路径加该文件中的序号，供「只跑一次」识别
- `event`：上面九个之一
- `source`：`"user" | "project" | "local"`
- `sourcePath`：所在文件
- `conditions`：可省略。有则每项为 `{ tool, pattern }`。`pattern` 用现有 glob：无 `*` 则全等
- `match`：`"all" | "any"`。没有条件时省略。只有一条条件时两者等效。同一条规则不能同时给出两种
- `denyMessage`：仅 `pre_tool` 可有。非空表示命中后拦截
- `action`：见下
- `once`：默认 `false`
- `background`：默认 `false`。`denyMessage` 非空或动作是注入提示词时，不能为 `true`
- `timeoutMs`：默认 `30000`。写了则必须是正数

### HookAction

四种之一：

- `{ type: "command"; command: string }`
- `{ type: "prompt"; text: string }`
- `{ type: "http"; url: string; method?: string; body?: string }`。`method` 省略为 `GET`
- `{ type: "subagent"; name: string }`。`name` 只用于日志，不启动对话

### 声明形状

每个文件是一个映射，字段 `hooks` 为规则数组。单条规则的字段对应：`event`、`if`、`deny`、`once`、`async`、`timeout_ms`、`action`。

`if` 可以省略。写成 `{ all: [...] }` 或 `{ any: [...] }`。同时写 `all` 和 `any` 则该文件不合法。非工具事件写了 `if` 不合法。`deny` 出现在非 `pre_tool` 上不合法。缺 `event` 或 `action` 不合法。

### HookFatalError

启动校验失败。

- `path`：文件路径
- `reason`：这条规则为什么不合法

错误文案同时包含二者。进程退出码为 1。

### HookSessionState

进程内状态，不写 JSONL。

- `addPrompt(sessionId, text)`：追加一条注入
- `prompts(sessionId): string`：拼成提醒用的文本。没有注入时为空串
- `markOnce(sessionId, ruleId)` / `hasOnce(sessionId, ruleId)`
- `clear(sessionId)`：离开会话时清掉注入和只跑一次标记

### HookEngine

- `rules(): HookRule[]`：已按用户、项目、本地排好
- `dispatch(input): Promise<HookDispatchResult>`

```ts
interface HookDispatchInput {
  event: HookEvent;
  sessionId: string;
  tool?: string;
  subject?: string;
}

interface HookDispatchResult {
  blocked: boolean;
  denyMessage?: string;
}
```

`dispatch` 只对 `pre_tool` 可能返回 `blocked: true`。拒绝说明是本次真正执行的、带 `denyMessage` 的命中规则，按顺序用换行拼起来。已标记只跑一次的规则整条跳过。动作抛错时记日志并继续下一条。

`subject` 由调用方用现有的权限参数提取得到：命令工具用命令文本，文件工具用路径。提取失败时，这条工具调用不跑 Hook 条件匹配，也不因此拦截，继续进入权限闸门。

## 模块设计

### `src/hooks/types.ts`

**职责：** `HookEvent`、`HookRule`、`HookAction`、`HookFatalError`、`HookDispatchInput`、`HookDispatchResult`。  
**对外接口：** 类型与错误类。致命错误的文案包含文件路径和原因。  
**依赖：** 无。

### `src/hooks/load.ts`

**职责：** 读取三份 YAML 并校验，拼成有序列表。  
**对外接口：** `loadHooks(workspaceRoot) → HookRule[]`。文件不存在返回空列表并继续。任一条不合法抛 `HookFatalError`。校验覆盖：事件名、`if` 只能出现在工具事件且不能同时有 `all` 和 `any`、`deny` 只能出现在 `pre_tool`、动作字段齐全、`timeout_ms` 为正数、带拒绝说明或注入提示词时不能 `async`。规则 `id` 用来源路径加文件内序号。  
**依赖：** `types.ts`、现有 YAML 解析。路径为 `~/.mewcode/hooks.yaml`、`<cwd>/.mewcode/hooks.yaml`、`<cwd>/.mewcode/hooks.local.yaml`。

### `src/hooks/state.ts`

**职责：** 进程内按会话保存注入文本和只跑一次标记。  
**对外接口：** `HookSessionState` 的 `addPrompt`、`prompts`、`markOnce`、`hasOnce`、`clear`。  
**依赖：** 无。

### `src/hooks/actions.ts`

**职责：** 执行四种动作。shell 在工作区目录运行，HTTP 按声明发送。两者的标准输出、标准错误和响应正文只记日志。超时后中止并记日志。注入调用 `addPrompt`。子 Agent 只记「尚未实现」和规则里的名字。动作抛错由引擎接住。  
**对外接口：** `runAction(rule, sessionId, state, log)`。`background` 为真时，shell 和 HTTP 不返回 Promise 的完成，引擎立刻继续。  
**依赖：** `state.ts`、Node 的子进程与 `fetch`。

### `src/hooks/engine.ts`

**职责：** 按事件筛选规则，跳过已执行的只跑一次规则，按加载顺序执行，汇总 `pre_tool` 的拒绝说明。  
**对外接口：** `HookEngine.dispatch(input)`。工具事件用 `permissionSubject` 得到的 `subject` 与 `ruleMatches` 做条件判断。`match` 为 `all` 时全部命中才算，为 `any` 时任一命中即可。没有 `subject` 时不拦截，也不把这条工具调用算作命中。非 `pre_tool` 的返回值 `blocked` 恒为 `false`。  
**依赖：** `load.ts` 的规则列表、`state.ts`、`actions.ts`、现有 `permissionSubject` 与 `ruleMatches`。

### 提示词

**职责：** `ReminderInput` 增加可选的 `hookPrompt`。环境提醒顺序改为：已激活 Skill、Skill 目录、Hook 注入、原有环境信息。空字符串时提醒与现在一致。  
**依赖：** `src/prompt/reminder.ts`。主循环每轮把 `HookSessionState.prompts(sessionId)` 传进去。

### 生命周期接入

**职责：** 在现有节点调用 `dispatch`，不在这些节点里解析 YAML。

- 进入会话界面：`session_start`。离开会话或进程退出：`session_end`，并 `clear(sessionId)`
- `ChatService` 确认这次输入要进入对话循环时：`turn_start`。该次 `runLoop` 结束时：`turn_end`。本地命令的 `dispatch` 路径不发这两个事件
- 会话存储写入用户消息或助手消息时：对应的消息事件。环境提醒不经过这里
- `guardCall` 在调用权限闸门之前：`pre_tool`。返回拦截时，生成失败的工具结果并跳过闸门和执行。工具执行结束后：`post_tool`
- 上下文管线发出压缩开始时：`compact`

**依赖：** `src/tui/chat-screen.tsx`、`src/cli.ts`、`src/chat/service.ts`、`src/session/store.ts`、`src/agent/scheduler.ts`、`src/context/pipeline.ts`。

### 启动

**职责：** 工具表就绪后调用 `loadHooks`。捕获 `HookFatalError` 时打印 `message` 并 `exit(1)`。把引擎交给对话门面和调度器。  
**依赖：** `src/cli.ts`。

## 模块交互

### 启动

`cli` 在工具表和 MCP 就绪之后调用 `loadHooks`。抛出 `HookFatalError` 时打印错误并 `exit(1)`，不进入界面。成功则构造一个 `HookEngine` 和一个 `HookSessionState`，交给对话门面、调度器和上下文管线。

### 进入与离开会话

界面打开某个会话时调用 `dispatch(session_start)`。用户回到会话列表，或进程收到退出信号时，先 `dispatch(session_end)`，再 `state.clear(sessionId)`。再次进入同一会话会重新发 `session_start`，注入文本和只跑一次标记都是空的。

### 回车

`ChatService.send` 仍先处理 Skill 刷新和斜杠命令。

- 本地命令：走原来的处理，不发 `turn_start` / `turn_end`。
- 普通文本，或 Skill、`/plan`、`/do` 这类会把正文送进对话循环的命令：在调用主循环之前 `dispatch(turn_start)`。主循环的 `run` 结束时，无论完成、取消、出错还是达到轮次上限，都 `dispatch(turn_end)`。

### 消息

`SessionStore.appendMessage` 在写入成功后发消息事件。`role` 为 `user` 时发 `user_message`，为 `assistant` 时发 `assistant_message`。`tool` 角色不发。环境提醒只存在于当次请求的内存消息里，不经过 `appendMessage`。

### 主循环每一轮

拼环境提醒时，在 Skill 目录之后读 `state.prompts(sessionId)`。有文本就放进提醒，没有就保持原样。这段文字不写入会话存档。

### 工具

`guardCall` 在权限闸门之前：

1. 用 `permissionSubject` 取出 `subject`。取不到则跳过 Hook，直接进入现有闸门。
2. `dispatch(pre_tool)`。同步动作在这里等待；异步的 shell 或 HTTP 只负责发出。
3. 返回 `blocked` 时，把 `denyMessage` 当作失败的工具结果交回模型，函数返回，不调用闸门，也不执行工具。
4. 未拦截时，走现有权限闸门。拒绝则仍是现在的拒绝结果。
5. 工具真正执行完，无论成功或失败，`dispatch(post_tool)`，然后再把结果写入会话。

### 压缩

上下文管线在发出压缩开始事件的同时 `dispatch(compact)`。压缩是否继续，只由现有管线决定。

### 一条规则的执行

`dispatch` 按加载顺序看规则。事件不同、条件不中、或该会话已标记只跑一次，则整条跳过。命中后先 `markOnce`（若声明了只跑一次），再 `runAction`。动作抛错只记日志。`pre_tool` 上带拒绝说明的命中规则，其说明按这个顺序用换行拼进返回值。

## 文件组织

```
src/hooks/
├── types.ts          — HookEvent、HookRule、HookAction、HookFatalError、dispatch 入参与结果
├── load.ts           — 读取三份 YAML，校验并按用户、项目、本地排序
├── state.ts          — 会话注入文本与只跑一次标记
├── actions.ts        — shell、HTTP、注入提示词、子 Agent 占位
├── engine.ts         — 匹配、跳过、按序执行、汇总拦截
└── index.ts          — 对外导出

src/config/paths.ts       — 三份 hooks YAML 的路径
src/prompt/reminder.ts    — 环境提醒加入 Hook 注入段
src/prompt/types.ts       — ReminderInput 增加 hookPrompt
src/agent/scheduler.ts    — pre_tool 在权限闸门之前，post_tool 在执行之后
src/agent/loop.ts         — turn_start / turn_end，提醒带上注入文本
src/session/store.ts      — 用户与助手消息落盘后发消息事件
src/context/pipeline.ts   — 压缩开始时发 compact
src/chat/service.ts       — 只有进入对话循环才发回合事件
src/tui/chat-screen.tsx   — 进入会话发 session_start，离开发 session_end 并清空
src/cli.ts                — 启动时 loadHooks，致命错误 exit(1)
docs/11-hooks/plan.md
```

磁盘上的三份声明不进仓库：`~/.mewcode/hooks.yaml`、`<cwd>/.mewcode/hooks.yaml`、`<cwd>/.mewcode/hooks.local.yaml`。本地级文件与现有 `permissions.local.yaml` 一样，不纳入版本跟踪。

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 条件语法 | 复用现有 `ruleMatches`：全等，或带 `*` 的 glob | 权限已经这么匹配。反向和正则不在这一步 |
| 匹配对象 | 工具事件用 `permissionSubject` 的命令文本或路径。取不到 subject 时不拦截 | 和权限看同一段参数，避免两套提取 |
| 条件组合 | `if.all` 或 `if.any`，不能同时写 | 对应「全部满足」或「任一满足」 |
| 规则顺序 | 用户、项目、本地，文件内保持原序。没有优先级字段 | 三份都执行，互不覆盖 |
| 不合法规则 | 加载时抛 `HookFatalError`，启动 `exit(1)` | 集中校验要在进入界面前失败 |
| 运行时失败 | 动作异常、超时、子 Agent 占位都只记日志 | 不打断当前任务 |
| 拦截点 | `guardCall` 在权限闸门之前。拦截则返回工具失败结果 | 用户不会先看到确认框 |
| 拒绝说明 | 仅 `pre_tool` 的 `deny`。命中的说明按顺序用换行拼接 | 没写 `deny` 的规则只做动作 |
| 注入位置 | 环境提醒里，Skill 目录之后、环境信息之前。不写 JSONL | 后续每轮都能看到，离开会话即消失 |
| 只跑一次 | 内存键为 `sessionId + ruleId`。`ruleId` 是文件路径加序号。离开会话时删除 | 这一步不持久化 |
| 异步 | 仅 shell 和 HTTP，且该规则没有 `deny`。引擎不等待 | 注入和拦截必须在当前调用里完成 |
| 超时 | 默认 30 秒，可用正数 `timeout_ms` 覆盖 | 与现有工具超时同一量级 |
| 子 Agent | `action.type: subagent` 只打日志 | 真实运行留给后续章节 |
| 回合边界 | 只有进入 `runLoop` 的输入才发 `turn_start` / `turn_end` | 本地斜杠命令不算一轮 |
| 消息边界 | 只在 `appendMessage` 成功写入用户或助手消息后触发 | 提醒和 Hook 日志不会变成消息事件 |
| 本地文件 | `hooks.local.yaml` 不进版本库 | 与 `permissions.local.yaml` 一致 |

## Spec 覆盖

| 需求 | 归属 |
|------|------|
| F1–F4 | `load.ts`、`engine.ts`、`state.ts` |
| F5–F9 | 生命周期接入各调用点 |
| F10–F12 | `engine.ts` 与现有权限匹配 |
| F13–F15 | `scheduler.ts` 的 `pre_tool` 与权限闸门 |
| F16–F20 | `actions.ts` |
| N1 | `cli.ts` 捕获致命错误 |
| N5、N6 | 提醒注入与 `state.clear` |
