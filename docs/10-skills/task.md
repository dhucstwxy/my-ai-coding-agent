# Skill Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/skills/types.ts` | SkillRecord、致命错误、警告、SkillRun |
| 新建 | `src/skills/parse.ts` | frontmatter 与正文 |
| 新建 | `src/skills/discover.ts` | 单层扫描 |
| 新建 | `src/skills/catalog.ts` | 三层合并与致命校验 |
| 新建 | `src/skills/session.ts` | 激活表与 `$ARGUMENTS` |
| 新建 | `src/skills/tools-view.ts` | 白名单交集 |
| 新建 | `src/skills/load-tool.ts` | `load_skill` |
| 新建 | `src/skills/slash.ts` | 短命令同步 |
| 新建 | `src/skills/run.ts` | 共享 / 独立执行 |
| 新建 | `src/skills/index.ts` | 导出 |
| 新建 | `src/skills/builtin/{commit,review,test}/SKILL.md` | 三个样板 |
| 修改 | `src/config/paths.ts` | 项目与用户 Skill 目录 |
| 修改 | `src/commands/registry.ts` | 按名字卸下命令 |
| 修改 | `src/commands/types.ts` | 清掉本会话激活 |
| 修改 | `src/commands/builtin/clear.ts` | `/clear` 时清激活 |
| 修改 | `src/commands/register-builtins.ts` | 不再注册内置 review |
| 修改 | `src/tools/create-registry.ts` | 注册 `load_skill` |
| 修改 | `src/prompt/reminder.ts` | 提醒最前面放 Skill |
| 修改 | `src/agent/loop.ts` | 工具视图与模型 |
| 修改 | `src/chat/service.ts` | 回车前 refresh，接执行器 |
| 修改 | `src/cli.ts` | 启动校验，失败 exit(1) |

## T1: 类型

**文件：** `src/skills/types.ts`  
**依赖：** 无  
**步骤：**
1. 定义 `SkillScope`、`SkillMode`、`SkillRecord`、`SkillWarning`、`SkillRun`
2. 定义 `SkillFatalError`，`kind` 为 `duplicate_name` 或 `unknown_tool`，带 `skillName`、`scope`、可选 `toolName`
3. 错误文案包含 Skill 名字；`unknown_tool` 时还包含工具名字

**验证：** `npm run typecheck`

## T2: 解析入口

**文件：** `src/skills/parse.ts`  
**依赖：** T1  
**步骤：**
1. 用现有 `yaml` 读取开头 `---` frontmatter，其余为正文
2. 读 `name`、`description`、`tools`、`mode`、`history`、`model`
3. 名字转小写，必须匹配 `^[a-z0-9]+(-[a-z0-9]+)*$`
4. `mode` 省略为 `shared`；`history` 省略为 `0`；`tools` 省略为 `undefined`
5. 缺名字、缺说明、名字非法、`history` 为负、YAML 损坏时返回 `SkillWarning`，不抛致命错误
6. `$ARGUMENTS` 保持原样

**验证：** `npx tsx` 断言合法文件得到 record；缺说明得到 warning。脚本删

## T3: 单层扫描

**文件：** `src/skills/discover.ts`  
**依赖：** T2  
**步骤：**
1. 目录不存在返回空 records 和空 warnings
2. 根目录 `*.md` 当作单文件 Skill，`packageDir` 为空，`companions` 为空
3. 子目录中存在 `SKILL.md` 时解析为能力包；同目录下其余文件列入 `companions`，不递归成新 Skill
4. 解析失败的文件进入 warnings，其它文件继续

**验证：** 临时目录放一份坏 md、一份合法 md、一个含 `SKILL.md` 和 `templates/a.md` 的子目录。断言 2 条 record、1 条 warning，附属文件只有 `templates/a.md`。脚本删

## T4: 目录合并

**文件：** `src/skills/catalog.ts`、`src/config/paths.ts`  
**依赖：** T3  
**步骤：**
1. `paths.ts` 增加项目目录 `<cwd>/.mewcode/skills` 与用户目录 `~/.mewcode/skills`
2. 内置目录用 `src/skills/builtin` 相对模块文件定位
3. `refresh(toolNames)`：各层先扫描；同层同名抛 `SkillFatalError(duplicate_name)`
4. 再按内置、用户、项目覆盖。白名单中的名字必须在 `toolNames` 内或等于 `load_skill`，否则抛 `unknown_tool`
5. 实现 `list`、`get`（大小写不敏感）、`warnings`、`catalogText`（只有名字和说明）

**验证：** 三层同名时 `get` 返回项目级。同层两份同名抛错且消息含名字。白名单含 `no_such_tool` 抛错且消息含 Skill 名和工具名。单份坏文件只进 warnings。脚本删

## T5: 激活表

**文件：** `src/skills/session.ts`  
**依赖：** T1、T4  
**步骤：**
1. `activate` 按会话保存名字和参数，同名再次激活只更新参数，多个名字按先后保留
2. `clear(sessionId)` 只清该会话
3. `modelFor` 从后往前取第一个写了 `model` 的已激活 Skill
4. `pinnedText` 用目录里的当前正文把全部 `$ARGUMENTS` 换成参数；无参数换成空串。目录中已消失的名字从激活表删除

**验证：** 正文含两处 `$ARGUMENTS`，传入 `fix` 后两处都是 `fix`；不传则两处为空。后激活的模型覆盖先激活的。脚本删

## T6: 工具视图

**文件：** `src/skills/tools-view.ts`  
**依赖：** T1  
**步骤：**
1. 实现 `visibleToolNames`
2. `plan` 先留下 `read_file`、`glob_files`、`grep_search`；`execute` 留下全部
3. 只对 `tools !== undefined` 的已激活记录取交集；都省略则不收窄
4. 结果始终包含 `load_skill`。交集为空时结果只有 `load_skill`

**验证：** 两个白名单 `[read_file, grep_search]` 与 `[grep_search, run_command]` 的交集为 `grep_search` 加 `load_skill`。无白名单时原列表还在且含 `load_skill`。脚本删

## T7: 内置样板

**文件：** `src/skills/builtin/commit/SKILL.md`、`review/SKILL.md`、`test/SKILL.md`  
**依赖：** T2 的字段约定  
**步骤：**
1. 三份都是共享模式，正文含 `$ARGUMENTS`
2. `commit`：根据当前改动准备提交；白名单 `read_file`、`glob_files`、`grep_search`、`run_command`
3. `review`：审查当前工作并给出风险与建议；白名单只有三个只读工具
4. `test`：运行测试并汇报；白名单与 `commit` 相同

**验证：** `SkillCatalog.refresh` 后 `list` 含这三个名字，`review.tools` 长度为 3。脚本删

## T8: 卸下命令

**文件：** `src/commands/registry.ts`  
**依赖：** 无  
**步骤：**
1. 增加 `unregister(name)`：按小写名字找到定义，删掉该定义的主名和全部别名
2. 名字不存在时不抛错

**验证：** 注册带别名的命令后 `unregister` 主名，`get` 主名和别名都为空。脚本删

## T9: 清屏钩子

**文件：** `src/commands/types.ts`、`src/commands/builtin/clear.ts`  
**依赖：** 无  
**步骤：**
1. `CommandContext` 增加 `clearActivatedSkills(): void`
2. `clear` 的 handler 先调用它，再 `ui.clearScreen()`

**验证：** 假 context 上 `/clear` 分发后，清激活与清屏各调用一次。脚本删

## T10: 去掉内置 review 命令

**文件：** `src/commands/register-builtins.ts`  
**依赖：** 无  
**步骤：**
1. `buildDefaultRegistry` 不再注册 `reviewCommand`
2. 保留文件可暂不删除，但默认注册表里不能再有 `review`

**验证：** `buildDefaultRegistry().get("review")` 为 `undefined`，`get("help")` 仍在。脚本删

## T11: 短命令同步

**文件：** `src/skills/slash.ts`  
**依赖：** T4、T8  
**步骤：**
1. 保留名集合：`clear`、`help`、`plan`、`do`、`compact`、`permission`、`session`、`memory`、`status`
2. `syncSkillCommands` 先卸下上一批 Skill 命令，再为当前目录里非保留名注册 `/name`
3. handler 调用注入的 `runSkill`，参数为短命令余下的文本
4. 记住本批注册过的名字，供下次同步卸下

**验证：** 目录含 `review` 与 `help` 时，同步后 `get("review")` 是 Skill，`get("help")` 仍是原来的帮助命令。再同步成只有 `commit` 时，`get("review")` 为空。脚本删

## T12: load_skill

**文件：** `src/skills/load-tool.ts`、`src/tools/create-registry.ts`  
**依赖：** T5  
**步骤：**
1. 工具名 `load_skill`，无副作用。参数 `name` 必填，`args` 可选
2. 找不到名字时返回失败文本，不抛致命错误
3. 共享模式：`activate` 后返回替换正文和附属文件路径，不另开循环
4. 独立模式：调用注入的独立执行函数，返回值作为工具结果
5. `createDefaultRegistry` 注册该工具。注册函数接收 catalog、session 和独立执行回调

**验证：** 假 catalog 中激活共享 Skill，返回文本含正文且不含未替换的 `$ARGUMENTS`。未知名字返回失败。`registry.get("load_skill")` 存在。脚本删

## T13: 执行器

**文件：** `src/skills/run.ts`  
**依赖：** T5、T6  
**步骤：**
1. `runSkill` 先 `activate`
2. 用户任务：`args` 非空用 `args`，否则用「请按已激活的该 Skill 说明执行」
3. 共享模式调用注入的 `submitToAgent(sessionId, task)`，不再解析斜杠
4. 独立模式调用注入的循环函数。输入消息只含主会话最近 `history` 条加上这句任务。结束后把最后一段助手正文 append 到主会话；没有正文时写入「该 Skill 已结束且没有文本结果」
5. `model` 有值时在供应商列表里按 `model` 字段查找。找不到则本次失败并说明原因，不调用循环

**验证：** 共享模式断言 `submitToAgent` 收到的是参数文本，不是 `/commit ...`。独立模式 `history: 2` 时循环只看到 2 条历史加任务，主会话新增的是摘要而不是中间工具消息。未知模型不调用循环。脚本删

## T14: 环境提醒

**文件：** `src/prompt/reminder.ts`  
**依赖：** 无  
**步骤：**
1. `ReminderInput` 增加可选 `pinnedText`、`catalogText`
2. 环境提醒正文顺序：已激活块、Skill 目录块、原有工作区/时间/系统信息
3. 两段都空时，提醒与原来一致

**验证：** 传入两段文本时，输出中已激活块位于目录块之前，目录块位于工作区路径之前。脚本删

## T15: 主循环接入

**文件：** `src/agent/loop.ts`  
**依赖：** T6、T14  
**步骤：**
1. 每轮把 `pinnedText` 和 `catalogText` 传给 `buildReminders`
2. 工具列表改为 `visibleToolNames` 的结果，再从注册表取出定义
3. 请求模型使用注入的 `resolveModel(sessionId)`；未注入时仍用当前供应商模型
4. 稳定系统前缀的拼接不加入 Skill 正文

**验证：** `npm run typecheck`。打桩一轮，断言提醒文本含目录说明且工具名集合含 `load_skill`

## T16: 对话门面

**文件：** `src/chat/service.ts`  
**依赖：** T4、T11、T12、T13、T15  
**步骤：**
1. 构造时接收 `SkillCatalog`、`SkillSession`，并把 `runSkill`、独立执行回调接到 `load_skill` 与短命令
2. `send` 在 `dispatch` 之前 `refresh`。`SkillFatalError` 时 `console.error` 后 `process.exit(1)`
3. refresh 成功后 `syncSkillCommands`，warnings 可被界面读到
4. `clearActivatedSkills` 接到 `SkillSession.clear`
5. 独立循环复用现有 `AgentLoop`，但不把中间消息写入主会话；摘要由 T13 写入

**验证：** `npm run typecheck`

## T17: 启动

**文件：** `src/cli.ts`、`src/skills/index.ts`  
**依赖：** T16  
**步骤：**
1. MCP 连接完成、`load_skill` 已注册之后调用第一次 `refresh`
2. 捕获 `SkillFatalError`，打印 `message`，`exit(1)`
3. 成功则 `syncSkillCommands`，警告并入 `startApp` 的 warnings
4. `index.ts` 导出 catalog、session、错误类型和同步函数

**验证：** `npm run typecheck`。临时把内置样板复制出同层重名时，启动路径返回或退出码为 1，且输出含该名字。测完恢复样板

## 执行顺序

```
T1 → T2 → T3 → T4 → T5 → T13
              ↘ T7 ↗
T6 ────────────────→ T15 → T16 → T17
T8 → T11 ───────────↗
T9 → T16
T10
T12 → T16
T14 → T15
```

推荐串行：T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10 → T11 → T12 → T13 → T14 → T15 → T16 → T17。
