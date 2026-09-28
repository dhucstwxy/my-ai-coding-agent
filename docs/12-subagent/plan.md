# 子 Agent Plan

## 架构概览

子 Agent 是主循环旁边的一条独立运行路径。主对话仍用现有的 `AgentLoop`。委派工具只负责校验参数、建立任务、等待或转入后台。真正的模型请求、工具执行和 Hook 发生在子循环里。子循环复用 `AgentLoop` 的回合和工具调度，但换成自己的存档、权限记录、系统提示和工具列表。

| 组件 | 职责 |
|------|------|
| **AgentCatalog** | 读取项目、用户、内置三处角色文档。同名按项目、用户、内置覆盖。坏文件跳过并留下原因。同一层级重名，或白名单、黑名单点到不存在的工具，抛出致命错误。每次委派前重新读取。 |
| **委派工具 `agent`** | 始终注册。参数是类型、角色名、任务说明、是否后台。定义式和 Fork 式走同一工具。启动前失败直接返回原因，不建任务。 |
| **请求快照** | 父循环每次发出模型请求时，记下系统提示、工具列表和消息。Fork 复制最近一次快照，再把任务说明接在消息后面。 |
| **子循环** | 单独的会话存档，不写父会话 JSONL。定义式的系统提示只有角色正文。Fork 使用快照里的系统提示和工具列表。轮次上限、模型在启动时定好。结束时不跑父会话的记忆更新。 |
| **工具视图** | 决定发给模型的工具列表，并在执行时再拦一次。定义式去掉 `agent`，再按白名单、黑名单收窄。Fork 使用快照里的原列表。列表定下之后，转入后台不改它。执行到 `agent`，或执行到角色过滤后不允许的工具，返回失败说明，子循环继续。 |
| **权限隔离** | 每个子 Agent 一份档位和本会话放行。永久放行仍走现有的本地规则写入。前台询问复用当前确认框。后台用一个不弹界面的拒绝器，需要询问的调用直接拒绝。 |
| **任务板** | 进程内记录标识、类型、状态、最终答复和用量。前台等待时累计实际运行时间，权限确认期间暂停计时，满 60 秒转入后台。按 `b` 也可以转入。Esc 取消前台任务。离开父会话或进程退出时，取消名下仍在跑的子循环并丢掉记录。 |
| **结果送回** | 非 Hook 的后台任务完成后，把标识、最终答复和用量写成父会话的一条输入。父循环空闲就接着跑一轮，不再把这段正文追加第二次。父循环正忙则排队，等这一轮结束后按完成顺序写入，再跑一轮。Hook 启动的任务只把最终答复写日志。 |
| **界面** | 有进行中的后台任务时展示标识和状态。前台子 Agent 运行且确认框未打开时，`b` 转入后台。确认框打开时沿用现有的确认键和 Esc。 |
| **Hook** | 子循环使用自己的会话标识，触发回合、消息、工具和压缩，不触发会话开始和结束。注入和只跑一次落在这个标识上，结束时清掉。Hook 的子代理动作改为按名字启动定义式后台任务，完成时只记日志。 |

数据流：

```
委派前
  → AgentCatalog 重新读取
  → 致命错误则 exit(1)，不留下进行中的任务
  → 环境提醒附上角色名字和用途，不含正文

主 Agent 调用 agent
  → 类型、角色、任务、模型不合法：返回失败，不建任务
  → 合法：建立任务
       定义式：空白存档 + 角色正文 + 过滤后的工具列表
       Fork：复制最近一次请求快照 + 任务说明
  → 前台：停在这次工具调用上
       满 60 秒或按 b：工具结果改为「已在后台」，子循环继续
       Esc：停掉子循环，工具结果为取消
       正常结束：工具结果为最终答复
  → 后台（含 Fork、Hook）：工具调用或 Hook 立即返回
       结束时非 Hook：写入父会话并在合适的边界再跑一轮
       结束时 Hook：只记日志

子循环内部
  → turn / message / tool / compact 用子会话标识
  → 工具先过执行期过滤，再过该子 Agent 自己的权限
  → 用量累加到任务，不计入父会话上下文
```

计划模式不隐藏 `agent`，Skill 白名单也不拿掉它，与 `load_skill` 相同。定义式的工具列表只按角色过滤。Fork 复制父请求当时的工具列表；父会话处于计划模式时，那份列表本身就是当时发给模型的那一套。

## 核心数据结构

### AgentRecord

读取并校验通过后的一个角色。

- `name`：小写。只含小写字母、数字和连字符
- `description`：可省略。用途说明
- `tools`：可省略。省略表示不收窄。空数组表示写了白名单但一条都没有
- `disallowedTools`：可省略。省略或空数组表示不额外去掉
- `model`：可省略。委派时再对照配置
- `maxTurns`：可省略。省略则用主对话的轮次上限。写了则是正整数
- `permission`：可省略。`"strict" | "default" | "allow"`
- `body`：系统提示正文，非空
- `scope`：`"project" | "user" | "builtin"`
- `path`：所在文件

### 声明形状

每个角色是一份 Markdown。开头的 YAML 元信息字段为：`name`、`description`、`tools`、`disallowedTools`、`model`、`maxTurns`、`permission`。其余是正文。

`tools` 与 `disallowedTools` 都是字符串数组。同一工具两边都有时，执行期以黑名单为准，发给模型的列表里也不留它。`permission` 只接受现有三档。`maxTurns` 只接受正整数。缺 `name`、名字不合法或正文为空，这个文件变成一条警告，不进入目录。

### AgentFatalError

重新读取失败。进程退出码为 1。

- `name`：角色名。同层重名时必有
- `tool`：可省略。点到不存在的工具时必有
- `reason`：为什么失败

错误文案里，重名含角色名；未知工具同时含角色名和工具名。

### AgentCatalog

- `refresh(toolNames: Set<string>): void`：重扫三处目录。致命错误抛 `AgentFatalError`。跳过的文件留在 `warnings()`
- `get(name: string): AgentRecord | undefined`
- `catalogText(): string`：只有名字和用途。没有用途时只有名字。没有角色时为空串
- `warnings(): { path: string; reason: string }[]`

### 委派参数

```ts
interface AgentToolInput {
  type: "defined" | "fork";
  task: string;
  name?: string;
  background?: boolean;
}
```

`defined` 必须有非空 `name` 和 `task`。`fork` 必须有非空 `task`，忽略 `name`。`background` 省略视为否。`fork` 即使为否也进入后台。

### RequestSnapshot

父循环最近一次真正发出的模型请求。

```ts
interface RequestSnapshot {
  system: string;
  tools: ToolDefinition[];
  messages: ChatMessage[];
}
```

Fork 复制这三份，再追加一条用户消息，内容是 `task`。没有快照时 Fork 失败，不建任务。定义式不读快照。

### SubAgentTask

进程内的一份后台或前台任务。不写盘。

- `id`：本次进程内唯一
- `parentSessionId`：结果要送回的父会话。Hook 启动的任务也记下父会话，但完成时不写入它
- `childSessionId`：子循环存档、权限档位、本会话放行和 Hook 共用的标识
- `kind`：`"defined" | "fork"`
- `roleName`：定义式有。Fork 没有
- `status`：`"running" | "completed" | "failed" | "cancelled"`
- `background`：当前是否已转入后台
- `notify`：`"parent" | "log"`
- `finalText`：结束时的最终答复
- `usage`：`{ inputTokens: number; outputTokens: number }`。只累加这个子循环的模型用量
- `runningMs`：前台实际运行毫秒。权限确认期间不增加

### TaskBoard

- `create(task): SubAgentTask`
- `get(id): SubAgentTask | undefined`
- `listRunning(parentSessionId): SubAgentTask[]`
- `markBackground(id): void`
- `finish(id, status, finalText): void`
- `addUsage(id, inputTokens, outputTokens): void`
- `addRunningMs(id, ms): void`
- `enqueue(parentSessionId, text): void`：待送回的正文，按完成顺序
- `drain(parentSessionId): string[]`：取出并清空该会话的待送回正文
- `clearParent(parentSessionId): void`：取消名下仍在跑的子循环，丢掉任务和待送回正文

同一 `SessionGrantStore` 和 `PermissionModeStore` 按 `childSessionId` 分开。子 Agent 的档位在启动时写入自己的标识：角色写了用角色的，没写则复制启动那一刻父会话的档位。永久放行追加本地规则时，同时追加父会话闸门已经加载的规则列表，父会话不用重启就能命中。

### 工具视图

```ts
function visibleTools(input: {
  kind: "defined" | "fork";
  all: ToolDefinition[];
  role?: AgentRecord;
  snapshot?: RequestSnapshot;
}): ToolDefinition[]
```

定义式从 `all` 去掉名为 `agent` 的工具，再按 `role.tools` 与 `role.disallowedTools` 收窄。Fork 返回 `snapshot.tools` 的副本。返回值在子循环启动时固定，转入后台不重新计算。

执行期：工具名是 `agent`，或工具名不在这份固定列表里，就不进入权限闸门，直接把失败说明交回子循环。

## 模块设计

### `src/agents/types.ts`

**职责：** `AgentRecord`、`AgentToolInput`、`RequestSnapshot`、`SubAgentTask`、`AgentFatalError`。  
**对外接口：** 类型与错误类。致命错误的文案含角色名；未知工具时再含工具名。  
**依赖：** 现有 `PermissionMode`、`ToolDefinition`、`ChatMessage`。

### `src/agents/catalog.ts`

**职责：** 解析 Markdown 角色并合并三处目录。  
**对外接口：** `AgentCatalog.refresh(toolNames)`、`get`、`catalogText`、`warnings`。目录为 `~/.mewcode/agents`、`<cwd>/.mewcode/agents`、内置目录。只收录该目录下的 `.md` 文件，不收录子目录。文件不存在或目录为空则这一级没有角色。单个文件缺名字、名字不合法、正文为空、最大轮次不是正整数或权限档位不在三档内，记一条警告并跳过。同一目录里名字重复，或 `tools`、`disallowedTools` 里的名字不在 `toolNames` 中，抛 `AgentFatalError`。合并后同名只保留项目，其次用户，再次内置。  
**依赖：** `types.ts`、现有 YAML 解析。内置目录这一步保持为空，不放样板文件。

### `src/agents/tools.ts`

**职责：** 计算子循环启动时固定的工具列表。  
**对外接口：** `visibleTools(...)`。定义式去掉 `agent`，再应用白名单和黑名单。Fork 返回快照列表的副本。  
**依赖：** `types.ts`。

### `src/agents/board.ts`

**职责：** 进程内任务表、前台计时和待送回队列。  
**对外接口：** `TaskBoard` 的 `create`、`get`、`listRunning`、`markBackground`、`finish`、`addUsage`、`addRunningMs`、`enqueue`、`drain`、`clearParent`。`clearParent` 只发取消，不负责写会话。  
**依赖：** `types.ts`。

### `src/agents/run.ts`

**职责：** 启动一个子循环并跟踪前台、后台和取消。  
**对外接口：** `startSubAgent(input): Promise<ToolResult>`。启动前的参数、角色或模型不合法时返回失败，不调用 `create`。合法时创建临时会话存档和子会话标识，写入该标识的权限档位，然后启动循环。`notify` 为 `parent` 且已在后台时，工具结果立即是「已在后台」加任务标识，结束后再 `enqueue`。`notify` 为 `log` 时不入队，结束时把最终答复交给日志函数。前台等待在子循环结束、满 60 秒、收到转入后台或收到取消时返回。60 秒只累加非权限确认的运行时间。取消时停掉子循环，结果为取消，不转入后台。  
**依赖：** `AgentCatalog`、`TaskBoard`、`visibleTools`、现有 `AgentLoop`、`PermissionGate`、`HookEngine`。模型解析复用配置里的供应商列表：没写 `model` 就用父会话当时的供应商和模型；写了则按模型名查找，找不到就返回失败。

### `src/agents/tool.ts`

**职责：** 注册始终存在的 `agent` 工具。  
**对外接口：** `createAgentTool(...)`。`execute` 先 `refresh`，再调用 `startSubAgent`。计划模式和 Skill 白名单都不移除这个工具。  
**依赖：** `catalog.ts`、`run.ts`。

### 父循环

**职责：** 记下最近一次模型请求快照；允许子循环换系统提示、工具列表和轮次上限；子循环结束时不调度父会话的记忆更新；把子循环的用量交给 `TaskBoard`，不写入父会话的上下文估计。  
**对外接口：** `AgentLoop` 增加读取快照的方法，以及一次运行可传入的系统提示、工具列表、轮次上限、是否跳过记忆更新。快照在请求发出前更新，内容就是这次的系统提示、工具定义和消息。  
**依赖：** 现有 `src/agent/loop.ts`。

### 工具执行期过滤

**职责：** 在权限闸门之前拒绝再委派和角色列表之外的工具。  
**对外接口：** 调度器增加可选的允许集合。未传时行为与现在相同。传入时，名为 `agent` 或不在集合中的调用直接成为失败的工具结果，不调用闸门，不执行工具。子循环因此不会进入 `agent` 的 `execute`，也不会在再委派时重新 `refresh`。  
**依赖：** 现有 `src/agent/scheduler.ts`。过滤之后，允许的工具仍走现有闸门。

### 权限询问开关

**职责：** 后台子循环不弹确认框。  
**对外接口：** 权限检查增加 `interactive`，缺省为真。为假时，原本要询问的调用变成拒绝，不调用确认器，说明交回子循环。前台子循环保持为真，并在确认开始时暂停计时、结束时恢复。永久放行的写入路径不变，写入成功后把同一条精确规则追加到父会话闸门已加载的列表。  
**依赖：** 现有 `PermissionGate` 与本地规则写入。

### 提醒

**职责：** 环境提醒增加角色目录。  
**对外接口：** `ReminderInput` 增加可选的 `agentCatalog`。顺序为：已激活 Skill、Skill 目录、Hook 注入、角色目录、原有环境信息。空字符串时输出与未传时一致。  
**依赖：** `src/prompt/reminder.ts`。进入对话循环前，父循环用 `catalogText()` 填这个字段。

### 结果送回

**职责：** 把后台结果写进父会话，并在空闲或当前轮次结束时再跑一轮。  
**对外接口：** `ChatService` 在回车进入循环前 `refresh` 角色目录。本地命令不刷新。`refresh` 抛出致命错误时打印文案并 `exit(1)`。循环结束路径调用 `drain`：有正文则按顺序追加为父会话的用户消息，再启动一轮且不再追加这些正文。任务完成时若父循环空闲，立刻走同一条送回；若正忙，只 `enqueue`。Hook 任务不经过这里。  
**依赖：** `TaskBoard`、现有 `ChatService` 与 `SessionStore`。

### 界面

**职责：** 展示进行中的任务，并把 `b` 和 Esc 交给前台子 Agent。  
**对外接口：** 有 `listRunning` 结果时，界面显示每条的标识和状态。确认框未打开、且存在前台子 Agent 时，`b` 调用转入后台，不把 `b` 写入输入框。没有前台子 Agent 时，`b` 仍是普通输入。确认框打开时忽略 `b`，Esc 仍拒绝本次询问并取消当前任务。离开会话时调用 `clearParent`。  
**依赖：** `TaskBoard`、现有 `src/tui/chat-screen.tsx`。

### Hook 动作

**职责：** 把子代理动作从占位改成真正启动。  
**对外接口：** `runAction` 在动作为 `subagent` 时调用注入的启动函数。启动函数使用该角色做定义式后台任务，`notify` 为 `log`，用户消息优先用用途说明。名字对不上或启动前失败时，启动函数把原因写入日志并正常返回。触发 Hook 的会话如果本身是子 Agent，启动函数只记「子 Agent 内不再启动」，不建立新任务。  
**依赖：** `src/hooks/actions.ts`、`startSubAgent`。引擎仍接住动作抛错，不结束父任务。

## 模块交互

### 启动

`cli` 在工具表就绪后注册 `agent`，并把 `startSubAgent` 交给 Hook 动作。此时不因为角色目录为空而失败。内置目录为空。进程退出时先对当前父会话 `clearParent`，再走现有的会话结束和 Hook 清理。

### 回车

`ChatService.send` 仍先处理斜杠命令。

- 本地命令：不 `refresh` 角色目录，也不送回后台结果。
- 即将进入对话循环：先 `catalog.refresh`。抛出 `AgentFatalError` 时打印文案并 `exit(1)`，不调用模型。成功后，这一轮的环境提醒使用 `catalogText()`。提醒顺序是已激活 Skill、Skill 目录、Hook 注入、角色目录、工作区信息。

`visibleToolNames` 与 `filterToolsForMode` 的结果始终保留 `agent`，规则与现有的 `load_skill` 相同。

### 父循环的一次模型请求

请求发出之前，父循环把这次的系统提示、工具定义和消息写成 `RequestSnapshot`，覆盖上一次。子循环不写这份快照。父循环的用量估计只累加父循环自己的返回，不加上子任务的 `usage`。

### 调用 `agent`

1. `execute` 再次 `refresh`。致命错误仍是 `exit(1)`。
2. 校验类型和任务说明。定义式还要 `get(name)`。模型名在配置里找不到，或 Fork 时还没有快照：返回失败的工具结果，不 `create`。
3. `startSubAgent` 建立临时会话目录和 `childSessionId`，在权限档位表写入该标识的档位，用 `visibleTools` 定下工具列表。
4. 子循环的 `run` 使用这份系统提示和工具列表，`maxIterations` 用角色的 `maxTurns` 或主对话上限。结束时不调度记忆更新。
5. 子循环的会话标识只用于它自己的 `appendMessage`、权限、Hook 注入和压缩。不调用会话进入那条 `session_start`。

### 子循环里的工具

调度器收到允许集合时：

1. 名为 `agent`，或不在集合中：失败结果交回子模型，不发 `pre_tool`，不进闸门，不执行。
2. 其余工具先 `pre_tool`（子会话标识），再进闸门。`interactive` 在后台为假，询问变为拒绝且不弹确认框。前台为真，确认开始时 `addRunningMs` 暂停，确认结束后继续累计。
3. 执行完后 `post_tool`，结果写入子会话存档，不写入父会话。

永久放行成功后，除了现有的本地文件追加，还把同一条精确 `allow` 放进父闸门已加载的规则列表。

### 前台等待

`startSubAgent` 同时等四件事，先到者决定这次工具结果：

- 子循环先结束：结果是最终答复。任务状态为已完成或已失败。不再 `enqueue`。
- 累计运行满 60 秒，或界面调用转入后台：`markBackground`，这次工具结果是已在后台加任务标识。子循环继续，取消令牌与父循环脱开，之后父循环的 Esc 不再取消它。
- 父循环取消：停掉子循环，工具结果为取消，状态为已取消，不转入后台。

权限确认框打开时界面不调用转入后台。没有前台任务时，`b` 不调用 `markBackground`。

### 后台结束

子循环结束且 `notify` 为 `parent`：`finish`，然后 `enqueue` 一条含标识、最终答复和用量的正文。

- 父循环正忙：只入队。该轮 `run` 的结束路径（完成、取消、出错、轮次上限）调用 `drain`。有正文则按顺序 `appendMessage` 为用户消息，再用「继续」入口跑一轮。这个入口不追加新的用户消息。
- 父循环空闲：立刻用同一条送回路径写消息并跑一轮。

同一轮结束时队列里有多条，全部写完再跑那一轮。这一轮若又把新结果入队，留到再下一次结束路径，不在同一次 `drain` 里嵌套启动。

`notify` 为 `log`：`finish` 后把最终答复写日志，不 `enqueue`，不启动父循环。

### Hook

Hook 引擎执行到 `subagent` 动作时调用启动函数，并带上这次 `dispatch` 的 `sessionId`。

- 该 `sessionId` 是某个任务的 `childSessionId`：日志写「子 Agent 内不再启动」，函数返回。
- 否则 `refresh`。致命错误仍 `exit(1)`。角色不存在或模型不存在：日志写原因，函数返回，不抛错。
- 角色存在：`startSubAgent`，类型为定义式，`background` 为真，`notify` 为 `log`。用户消息用 `description`；没有则用一句要求它按系统提示执行的说明。函数在任务转入后台后返回，不等子循环结束。

### 离开

用户离开当前会话时，先 `clearParent`：名下仍在跑的子循环被取消，任务和待送回队列删除。然后再发已有的 `session_end` 并清父会话的 Hook 状态。子会话自己的 Hook 注入和只跑一次在子循环结束或被取消时清掉。

## 文件组织

```
src/agents/
├── types.ts       — AgentRecord、委派参数、RequestSnapshot、SubAgentTask、AgentFatalError
├── catalog.ts     — 解析 Markdown，合并项目、用户、内置
├── tools.ts       — visibleTools
├── board.ts       — TaskBoard
├── run.ts         — startSubAgent，前台等待、后台交接、取消
├── tool.ts        — agent 工具
├── builtin/       — 内置角色目录，这一步保持为空
└── index.ts       — 对外导出

src/config/paths.ts         — 三处角色目录的路径
src/prompt/types.ts         — ReminderInput 增加 agentCatalog
src/prompt/reminder.ts      — 角色目录放在 Hook 注入之后、工作区信息之前
src/agent/loop.ts           — 请求快照、「继续」入口、子循环的系统提示与轮次、跳过记忆更新
src/agent/scheduler.ts      — 允许集合在权限闸门之前过滤
src/agent/plan-mode.ts      — 计划模式保留 agent
src/skills/tools-view.ts    — Skill 白名单保留 agent
src/permission/gate.ts      — interactive 为假时询问改为拒绝
src/chat/service.ts         — 进入循环前刷新角色，结束后送回后台结果
src/tui/chat-screen.tsx     — 进行中任务、b 转入后台、离开时 clearParent
src/hooks/actions.ts        — 子代理动作改为启动定义式后台任务
src/cli.ts                  — 注册 agent，接入 Hook，退出时清任务
docs/12-subagent/plan.md
```

磁盘上的角色不进仓库：`~/.mewcode/agents/*.md`、`<cwd>/.mewcode/agents/*.md`。项目级目录由用户自己添加，这一步不把样板写进仓库。子循环的会话放在临时目录，不写进父会话的 `.mewcode/sessions`。

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 入口 | 一个 `agent` 工具，用 `type` 区分定义式和 Fork | 工具列表始终稳定。Fork 才能带上与父请求相同的工具列表 |
| 子循环 | 复用 `AgentLoop`，换存档、系统提示、工具列表和会话标识 | 回合、工具调度和 Hook 不用再写一套 |
| Fork 前缀 | 复制最近一次 `RequestSnapshot`，任务说明接在消息之后 | 新任务之前的系统提示和工具列表与父请求相同。父对话之后的新消息不进入 Fork |
| 定义式系统提示 | 只用角色正文 | 不把主对话那份固定系统提示带进子 Agent |
| 子会话存放 | 临时目录 | 中间消息不写入父会话 JSONL |
| 权限记录 | 现有档位表和本会话放行，键用 `childSessionId` | 与父会话天然分开，不必再做一套闸门 |
| 后台询问 | `interactive: false` 时把询问改成拒绝 | 不换掉界面上的确认器，父会话的确认不受影响 |
| 再委派 | Fork 的工具列表仍可包含 `agent`，执行期在闸门前拒绝 | 列表与父请求一致。调用失败后子循环继续 |
| 工具列表 | `visibleTools` 的结果在启动时固定 | 转入后台不再改发给模型的列表 |
| 60 秒 | 确认期间不计时。若子循环已经结束，返回最终答复，不再报已在后台 | 看确认框时不会被转入后台。已经跑完就不必再送一次后台通知 |
| 送回 | 先写成用户消息，再用不追加消息的继续入口跑一轮 | 同一段正文只出现一次 |
| Hook 再启动 | 子会话上的子代理动作只记日志 | 回合 Hook 不会一层层开出新任务 |
| 致命角色 | 进入循环、调用 `agent`、Hook 启动前，`refresh` 失败都 `exit(1)` | 同层重名和未知工具在用到之前失败，不留下半截任务 |
| 记忆 | 子循环不调度记忆更新 | 子 Agent 的往来不写进长期记忆 |
| 离开会话 | `clearParent` 取消仍在跑的子循环并丢掉队列 | 任务记录不跨会话留下，离开后也不再写回 |

## Spec 覆盖

| 需求 | 归属 |
|------|------|
| F1 | `tool.ts`、`plan-mode.ts`、`skills/tools-view.ts`。类型不合法时不建任务 |
| F2、F4、F5 | `run.ts` 与子循环的系统提示、临时存档。最终答复只作为工具结果回到父会话 |
| F3、N5 | 父循环的 `RequestSnapshot`。Fork 复制后追加任务说明 |
| F6、F7、F8、N6 | `run.ts` 与 `board.ts`。前台等待、60 秒、按 `b`、Fork 强制后台 |
| F9、F24 | `board.ts` 的队列、`ChatService` 的送回、界面上的进行中任务 |
| F10、F13 | `chat-screen.tsx` 把 Esc 和 `b` 交给前台任务。确认框打开时不转入后台 |
| F11、F12、N4、N7 | 子会话标识上的档位和本会话放行。`gate.ts` 的 `interactive`。永久放行追加已加载规则 |
| F14–F18、N1 | `catalog.ts`。坏文件跳过，同层重名和未知工具在 `refresh` 时 `exit(1)` |
| F17 | `reminder.ts` 的角色目录 |
| F19–F21 | `tools.ts` 定列表，`scheduler.ts` 在闸门前拒绝再委派和列表外工具 |
| F22 | 子循环用自己的会话标识发回合、消息、工具和压缩，不发会话开始和结束 |
| F23、N2 | `hooks/actions.ts`。结果只记日志。子会话上不再启动新任务。失败不结束父任务 |
| N3 | 子会话在临时目录，父会话 JSONL 只有最终答复或后台交接 |
| N8 | 目录、列表、交接、权限和日志路径都不依赖真实模型。按键和界面用模拟输入 |
