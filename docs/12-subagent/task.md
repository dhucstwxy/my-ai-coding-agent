# 子 Agent Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/agents/types.ts` | 角色、委派参数、快照、任务、致命错误 |
| 新建 | `src/agents/catalog.ts` | 解析并合并三处角色 |
| 新建 | `src/agents/tools.ts` | 定死子循环的工具列表 |
| 新建 | `src/agents/board.ts` | 任务表、计时、待送回队列 |
| 新建 | `src/agents/run.ts` | 启动子循环，处理前台、后台和取消 |
| 新建 | `src/agents/tool.ts` | `agent` 工具 |
| 新建 | `src/agents/builtin/.gitkeep` | 空的内置目录 |
| 新建 | `src/agents/index.ts` | 导出 |
| 修改 | `src/config/paths.ts` | 三处角色目录 |
| 修改 | `src/prompt/types.ts` | `agentCatalog` |
| 修改 | `src/prompt/reminder.ts` | 提醒中插入角色目录 |
| 修改 | `src/agent/plan-mode.ts` | 计划模式保留 `agent` |
| 修改 | `src/skills/tools-view.ts` | Skill 白名单保留 `agent` |
| 修改 | `src/permission/gate.ts` | 后台不弹确认 |
| 修改 | `src/agent/scheduler.ts` | 闸门前按允许集合过滤 |
| 修改 | `src/agent/loop.ts` | 快照、继续入口、子循环参数 |
| 修改 | `src/chat/service.ts` | 刷新角色并送回结果 |
| 修改 | `src/tui/chat-screen.tsx` | 进行中任务、`b`、离开时清理 |
| 修改 | `src/hooks/actions.ts` | 子代理动作真正启动 |
| 修改 | `src/cli.ts` | 注册工具、接入 Hook、退出时清理 |

## T1: 类型

**文件：** `src/agents/types.ts`  
**依赖：** 无  
**步骤：**
1. 定义 `AgentRecord`、`AgentToolInput`、`RequestSnapshot`、`SubAgentTask`，字段与 plan 的核心数据结构一致
2. `AgentFatalError` 带 `name`、可选 `tool`、`reason`。重名的文案含角色名；未知工具的文案同时含角色名和工具名
3. 任务状态为 `running`、`completed`、`failed`、`cancelled`。送回方式为 `parent` 或 `log`

**验证：** `npm run typecheck`

## T2: 路径

**文件：** `src/config/paths.ts`、`src/agents/builtin/.gitkeep`  
**依赖：** 无  
**步骤：**
1. 增加用户目录 `~/.mewcode/agents`、项目目录 `<cwd>/.mewcode/agents`、内置目录 `src/agents/builtin`
2. 内置目录只放 `.gitkeep`，不放角色样板

**验证：** `npm run typecheck`。临时调用三个函数，用户和项目路径以 `agents` 结尾，内置路径指向 `src/agents/builtin`

## T3: 角色目录

**文件：** `src/agents/catalog.ts`  
**依赖：** T1、T2  
**步骤：**
1. `refresh(toolNames)` 只读取三处目录下的 `.md`，不读子目录。目录或文件不存在则这一级为空
2. 解析元信息 `name`、`description`、`tools`、`disallowedTools`、`model`、`maxTurns`、`permission`，其余为正文。读文件前把换行规范成 `\n`
3. 缺名字、名字不是小写字母数字与连字符、正文为空、`maxTurns` 不是正整数、`permission` 不是三档之一：记警告并跳过。名字登记为小写
4. 同一目录重名抛 `AgentFatalError`。`tools` 或 `disallowedTools` 里的名字不在 `toolNames` 中也抛，文案含角色名和工具名
5. 合并顺序为内置、用户、项目，同名以后出现的覆盖先前的。`get`、`catalogText`、`warnings` 按 plan 的约定

**验证：** 临时目录各放一条合法角色，顺序为项目覆盖用户、用户覆盖内置。缺名字的文件被跳过且其它仍在。同层重名和未知工具抛错，消息含名字。脚本删

## T4: 工具列表

**文件：** `src/agents/tools.ts`  
**依赖：** T1  
**步骤：**
1. 实现 `visibleTools`
2. 定义式从全部工具去掉 `agent`。写了 `tools` 就只留其中的名字；数组为空则结果为空。`disallowedTools` 再去掉对应名字。两边都有的以黑名单为准
3. 没写 `tools` 表示不收窄，没写 `disallowedTools` 表示不额外去掉。`load_skill` 不特殊保留，只按上面的规则
4. Fork 返回快照工具列表的副本，不按角色再滤

**验证：** 定义式结果不含 `agent`。空白名单得到空列表。`read_file` 同时在两边时不出现。Fork 结果与快照相同且含 `agent`。脚本删

## T5: 任务板

**文件：** `src/agents/board.ts`  
**依赖：** T1  
**步骤：**
1. 实现 plan 里的 `TaskBoard` 方法。`id` 在本次进程内唯一
2. `enqueue` 保持完成顺序。`drain` 取出并清空该父会话的队列，不影响其它父会话
3. `clearParent` 把名下 `running` 标为 `cancelled`，并清掉该父会话的队列。调用方负责真正停掉循环
4. `addRunningMs` 只改数字，不自己判断 60 秒

**验证：** 同一父会话按顺序入队两条，`drain` 得到同样顺序且第二次为空。`clearParent` 后该会话没有进行中任务，另一会话的任务还在。脚本删

## T6: 提醒

**文件：** `src/prompt/types.ts`、`src/prompt/reminder.ts`  
**依赖：** 无  
**步骤：**
1. `ReminderInput` 增加可选 `agentCatalog`
2. 环境提醒顺序改为：已激活 Skill、Skill 目录、Hook 注入、`agentCatalog`、原有环境信息
3. `agentCatalog` 为空时，输出与未传时一致

**验证：** 传入一段角色目录时，它位于 Hook 注入文本之后、工作区路径之前。未传时与现在的提醒一致。脚本删

## T7: 主 Agent 始终看得到委派工具

**文件：** `src/agent/plan-mode.ts`、`src/skills/tools-view.ts`  
**依赖：** 无  
**步骤：**
1. `filterToolsForMode` 在计划模式下仍保留名为 `agent` 的工具
2. `visibleToolNames` 在白名单收窄之后，若结果里没有 `agent` 且原始名单里有它，则加回去。规则与 `load_skill` 相同

**验证：** 计划模式的结果含 `agent` 和只读工具，不含 `write_file`。Skill 白名单只有 `read_file` 时，结果仍含 `load_skill` 和 `agent`。脚本删

## T8: 后台不弹确认

**文件：** `src/permission/gate.ts`  
**依赖：** 无  
**步骤：**
1. 权限检查增加可选 `interactive`，缺省为真
2. 为假时，原本要询问的调用直接拒绝，不调用确认器。说明交给调用方。已有的允许和拒绝规则不变
3. 永久放行写入本地规则成功后，把同一条精确 `allow` 追加到闸门已加载的规则列表

**验证：** 打桩确认器。`interactive: false` 且默认档下的 `run_command` 不调用确认器，结果为拒绝。`interactive` 缺省时确认器仍被调用。永久放行后，闸门内存中的规则含这条精确 `allow`。脚本删

## T9: 执行期过滤

**文件：** `src/agent/scheduler.ts`  
**依赖：** 无  
**步骤：**
1. `executeToolBatch` 增加可选的允许工具名集合。未传时行为与现在相同
2. 传入时，在 `pre_tool` 和权限闸门之前：名为 `agent`，或不在集合中的调用，返回失败工具结果，不发 `pre_tool`，不调用闸门，不执行
3. 集合中的其它工具仍先 Hook，再闸门，再执行

**验证：** 允许集合不含 `write_file` 时，该调用的闸门计数为 0，工具执行计数为 0。集合含 `read_file` 时，闸门仍被调用。未传集合时，现有调用仍进闸门。脚本删

## T10: 父循环与子循环参数

**文件：** `src/agent/loop.ts`  
**依赖：** T1、T6  
**步骤：**
1. 每次向模型发出请求之前，保存 `RequestSnapshot`：系统提示、工具定义、消息。提供读取最近一次快照的方法。子循环不写这份快照
2. 增加不追加用户消息的继续入口。它从现有存档进入下一轮
3. 一次运行可传入系统提示、工具列表、轮次上限、是否跳过记忆更新，以及用量回调。定义式传入的系统提示原样使用，不调用主对话那份固定系统提示
4. 跳过记忆更新时，结束路径不调度记忆。用量回调收到的是这一轮的输入和输出，不写入父会话的上下文估计
5. 环境提醒传入 `agentCatalog`。未传时提醒与现在一致

**验证：** `npm run typecheck`。打桩一轮：快照里的系统提示和工具名与该次请求相同。继续入口不会把同一句用户话再写入一次。跳过记忆时不调用记忆更新

## T11: 启动子循环

**文件：** `src/agents/run.ts`  
**依赖：** T3、T4、T5、T8、T9、T10  
**步骤：**
1. 实现 `startSubAgent`。类型、任务说明、角色或模型在启动前不合法时返回失败，不 `create`
2. 合法时创建临时会话和 `childSessionId`，写入该标识的权限档位：角色写了用角色的，没写则复制启动时父会话的档位。Fork 没有角色档位时用父会话当时的档位
3. 用 `visibleTools` 定下允许集合，传给子循环和调度器。定义式系统提示为角色正文，第一条用户消息为任务说明。Fork 复制快照并追加任务说明；没有快照则失败且不建任务
4. 子循环不发 `session_start`。结束时清掉该子会话的 Hook 注入和只跑一次，并删除临时会话目录
5. 前台同时等待结束、累计运行满 60 秒、转入后台和父循环取消。确认期间不累计。已经结束则返回最终答复且不入队。转入后台时返回已在后台和任务标识，子循环的取消与父循环脱开。父循环取消时停掉子循环，结果为取消
6. `notify` 为 `parent` 的后台任务结束时 `enqueue` 标识、最终答复和用量。`notify` 为 `log` 时只记日志。最终答复的形状按 spec 的 F5
7. 用量只 `addUsage`，不计入父会话上下文

**验证：** 打桩模型两轮：第一轮调一个允许的工具，第二轮只回正文。前台工具结果只有那段正文，父会话文件没有工具往来。指定后台时，返回里有任务标识且没有最终答复；子循环结束后队列里有最终答复。未知角色不产生任务。脚本删

## T12: 委派工具

**文件：** `src/agents/tool.ts`、`src/agents/index.ts`  
**依赖：** T3、T11  
**步骤：**
1. `createAgentTool` 的名字是 `agent`，有副作用。参数为 `type`、`task`、可选 `name`、可选 `background`
2. `execute` 先 `refresh`。`AgentFatalError` 打印文案并 `exit(1)`。其它失败返回工具结果
3. `index.ts` 导出目录、任务板、启动函数、工具工厂和致命错误

**验证：** `npm run typecheck`。`type` 缺失时工具结果为失败，任务板为空

## T13: 送回父会话

**文件：** `src/chat/service.ts`  
**依赖：** T10、T12  
**步骤：**
1. 即将进入对话循环前 `refresh`。致命错误 `exit(1)`。本地命令不刷新
2. 把 `catalogText()` 传进该轮提醒
3. 父循环每条结束路径 `drain`。有正文则按顺序追加为用户消息，再走继续入口，不把这些正文再追加一次
4. 后台任务完成时，父循环正忙则只入队；空闲则立刻用同一条送回路径写消息并跑一轮。同一次 `drain` 不嵌套启动下一轮

**验证：** 打桩引擎。`/help` 不调用 `refresh`。普通文本会 `refresh`。队列里有两条时，父会话新增两条用户消息，且各只出现一次，并自动再跑一轮。脚本删

## T14: 界面

**文件：** `src/tui/chat-screen.tsx`  
**依赖：** T5、T11  
**步骤：**
1. `listRunning` 非空时展示每条的标识和状态
2. 确认框未打开且存在前台子 Agent 时，`b` 转入后台，不写入输入框。没有前台子 Agent 时，`b` 仍是普通输入
3. 确认框打开时忽略 `b`。Esc 仍拒绝本次询问并取消当前任务
4. 离开会话时 `clearParent`，并停掉名下子循环，然后再走现有的会话结束

**验证：** 模拟按键。前台任务存在时 `b` 使任务 `background` 为真，输入框不含 `b`。确认等待时 `b` 不改变 `background`。离开后该父会话没有进行中任务。脚本或现有的输入处理函数调用，不必打开真实终端

## T15: Hook

**文件：** `src/hooks/actions.ts`  
**依赖：** T11  
**步骤：**
1. 子代理动作调用注入的启动函数。未注入时仍只记尚未实现，避免现有测试在未接线时抛错
2. `sessionId` 是某个任务的 `childSessionId` 时，只记「子 Agent 内不再启动」，不调用启动
3. 启动函数按角色名做定义式后台任务，`notify` 为 `log`。用户消息用用途说明；没有用途说明时，要求它按系统提示执行
4. 角色不存在或模型不存在时记日志并正常返回。`refresh` 的致命错误仍 `exit(1)`。函数在转入后台后返回，不等子循环结束

**验证：** 打桩启动函数。父会话上的子代理动作调用了它，日志在结束后含最终答复，父会话文件不含这段答复。子会话标识上再触发时，启动函数计数不增加，日志含「子 Agent 内不再启动」。未知名字只记失败，不抛错。脚本删

## T16: 启动接线

**文件：** `src/cli.ts`  
**依赖：** T12、T13、T14、T15  
**步骤：**
1. 工具表就绪后注册 `agent`，并把 `startSubAgent` 注入 Hook 动作
2. 角色目录为空时不退出
3. 进程退出时先 `clearParent` 当前父会话，再走现有的会话结束和 Hook 清理

**验证：** `npm run typecheck`。工具表里有 `agent`。临时项目目录放一份缺名字的角色时，进入对话循环的刷新只产生警告，进程不退出。同层两份同名角色时，退出码为 1 且输出含该名字。测完删除临时文件

## 执行顺序

```
T1 → T3 → T11 → T12 → T13 → T16
T2 ↗      ↗
T4 ↗
T5 ↗
T6 → T10 ↗
T7
T8 → T9 ↗
T14、T15 在 T11 之后，于 T16 前完成
```

推荐串行：T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10 → T11 → T12 → T13 → T14 → T15 → T16。
