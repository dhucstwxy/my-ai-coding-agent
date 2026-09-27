# Skill Plan

## 架构概览

Skill 收成独立一层。斜杠命令、工具白名单和提示词只消费它的结果，不自己扫磁盘。

| 组件 | 职责 |
|------|------|
| **SkillCatalog** | 扫描项目、用户、内置三级目录，解析入口文档，按优先级合并。同层重名或白名单指向不存在的工具时抛致命错误。单个解析失败记入警告并跳过。每次用户回车前 `refresh()`。 |
| **SkillSession** | 进程内、按会话保存已激活 Skill。不写入 JSONL。`/clear` 和新会话都清空。正文在每轮从目录里的当前内容重新取，磁盘改了下一轮就生效。 |
| **load_skill** | 系统级内置工具。按名字激活 Skill，返回替换参数后的入口正文，以及同包附属文件的位置。任何白名单都不能把它从工具列表里拿掉。 |
| **短命令桥** | 目录收录成功后，为每个 Skill 注册 `/名字`。`clear`、`help`、`plan`、`do`、`compact`、`permission`、`session`、`memory`、`status` 保留原命令。其余同名由 Skill 接管，现有 `/review` 固定提示不再注册。 |
| **工具视图** | 先按计划/执行模式过滤，再按已激活 Skill 的白名单取交集。没有写白名单的 Skill 不参与收窄。交集为空时只留 `load_skill`。权限闸门仍在执行前判断。 |
| **执行器** | 共享模式：激活后把参数作为用户任务送入当前 Agent 循环，结果留在主历史。独立模式：另开一段循环，只带最近 N 条主历史，中间消息不落主存档，结束时把最终文本作为摘要写回主历史。 |
| **提示词** | 可缓存的稳定系统前缀不动。名字和一句话说明、已激活的完整说明，都放进每轮重建的环境提醒里。已激活正文放在这段提醒的最前面。 |

数据流：

```
回车
  → SkillCatalog.refresh()
  → 致命错误则进程退出
  → 更新短命令
  → 斜杠命中 Skill：按元信息走共享或独立执行
  → 普通文本或共享任务：Agent 循环
       每轮：环境提醒 = 已激活正文 + Skill 目录 + 环境信息
       工具列表 = 模式过滤 ∩ 白名单，并始终保留 load_skill
       模型可调用 load_skill 再激活其它 Skill
```

内置 `commit`、`review`、`test` 是随程序发布的内置目录条目，和用户、项目目录用同一套解析。

## 核心数据结构

### SkillRecord

收录成功后的一条 Skill。

- `name`：小写短名，匹配 `^[a-z0-9]+(-[a-z0-9]+)*$`
- `description`：一句话说明
- `tools`：字符串数组；字段省略时为 `undefined`，表示不收窄。空数组表示写成了白名单但一个工具都没列，参与交集后只剩 `load_skill`
- `mode`：`"shared"` 或 `"isolated"`，省略时为 `"shared"`
- `history`：非负整数，省略时为 `0`。负数不当成合法记录
- `model`：可选模型名
- `body`：入口正文，可含零个或多个 `$ARGUMENTS`
- `scope`：`"project"`、`"user"` 或 `"builtin"`
- `entryPath`：入口文件绝对路径
- `packageDir`：目录型 Skill 的包目录；单文件 Skill 为空
- `companions`：同包附属文件的绝对路径列表，不含入口文件

`$ARGUMENTS` 每次出现都换成本次调用的整段参数。没有参数时换成空串。

### SkillFatalError

启动或回车前重扫时立即失败退出。

- `kind`：`"duplicate_name"` 或 `"unknown_tool"`
- `skillName`
- `scope`：重名发生的那一层
- `toolName`：仅 `unknown_tool` 时有

进程退出码为 1，错误文本同时包含 `skillName` 和（若有）`toolName`。

### SkillWarning

单个 Skill 解析失败，不阻断其它 Skill。

- `path`
- `reason`：缺名字、缺说明、名字非法、历史条数为负、frontmatter 无法解析等

### SkillCatalog

- `refresh(toolNames: ReadonlySet<string>): void`  
  重扫三级目录并合并。同层重名或白名单里的名字不在 `toolNames` 中时抛 `SkillFatalError`。`load_skill` 视为永远存在。
- `list(): SkillRecord[]`
- `get(name: string): SkillRecord | undefined`  
  查找前把名字转成小写。
- `warnings(): SkillWarning[]`
- `catalogText(): string`  
  只有名字和一句话说明，没有正文。

合并顺序：先内置，再用户，再项目。高优先级覆盖同名低优先级。覆盖发生在各层内部已经确认没有重名之后。

### SkillSession

进程内激活表，键是 `sessionId`。不写 JSONL。

- `activate(sessionId, name, args: string): void`  
  同一名字再次激活只更新参数。多个名字可以并存。
- `clear(sessionId): void`
- `active(sessionId): Array<{ name: string; args: string }>`  
  按激活先后排序。
- `modelFor(sessionId): string | undefined`  
  从后往前找第一个写了 `model` 的已激活 Skill。
- `pinnedText(sessionId, catalog): string`  
  用目录里的当前正文和本次参数做替换，拼成提醒最前面的块。Skill 已从目录消失时，从激活表去掉。

### 工具视图

```ts
visibleToolNames(input: {
  allNames: string[];
  planMode: "plan" | "execute";
  active: SkillRecord[];
}): string[]
```

先按计划模式留下只读工具，或在执行模式留下全部。再只对 `tools !== undefined` 的已激活 Skill 取交集。结果里始终加入 `load_skill`。没有任何 Skill 写白名单时，不收窄。

### load_skill 入参与返回

入参：`name`（必填），`args`（可选字符串）。  
返回给模型的文本：已激活标记、替换后的入口正文、附属文件路径列表。找不到名字时返回失败文本，不抛致命错误。

### 执行请求

```ts
interface SkillRun {
  sessionId: string;
  skill: SkillRecord;
  args: string;
}
```

共享模式把 `args` 作为主循环的用户任务；`args` 为空时，用户任务是一句「请按已激活的该 Skill 说明执行」。独立模式另开循环，输入消息是主会话最近 `history` 条再加上这一句任务。循环结束后，只把最后一段助手正文当作摘要追加到主会话。没有正文时，摘要写明该 Skill 已结束且没有文本结果。

## 模块设计

### `src/skills/parse.ts`

**职责：** 把一份入口 Markdown 拆成元信息和正文。  
**对外接口：** `parseSkillFile(path, scope) → { record } | { warning }`。用现有 YAML 库读开头的 frontmatter。`$ARGUMENTS` 原样留在正文里。历史条数为负、缺字段、名字不合法时返回 `SkillWarning`，不抛致命错误。  
**依赖：** 无。

### `src/skills/discover.ts`

**职责：** 只扫某一层目录的一层。根上的 `*.md` 是单文件 Skill。子目录里有 `SKILL.md` 的是能力包，同目录其余文件记入 `companions`，不再往下当成新 Skill。  
**对外接口：** `discoverScope(dir, scope) → { records, warnings }`。目录不存在视为空，不是错误。  
**依赖：** `parse.ts`。

### `src/skills/catalog.ts`

**职责：** 合并内置、用户、项目三层并做致命校验。  
**对外接口：** `SkillCatalog.refresh(toolNames)`、`list`、`get`、`warnings`、`catalogText`。各层先查同名，重名抛 `SkillFatalError`；通过后再按内置 → 用户 → 项目覆盖。白名单里的每个名字必须在 `toolNames` 里，或就是 `load_skill`。  
**依赖：** `discover.ts`。路径为 `<cwd>/.mewcode/skills`、`~/.mewcode/skills`，以及随源码发布的内置目录。

### `src/skills/session.ts`

**职责：** 按会话保存已激活名字和参数。  
**对外接口：** `activate`、`clear`、`active`、`modelFor`、`pinnedText`。`pinnedText` 每次从 `SkillCatalog` 取当前正文再替换 `$ARGUMENTS`。目录里已经没有的名字从激活表删除。  
**依赖：** `SkillCatalog`。

### `src/skills/tools-view.ts`

**职责：** 计算这一轮模型能看见的工具名。  
**对外接口：** `visibleToolNames(...)`。顺序是计划/执行模式过滤，再对写了 `tools` 的已激活 Skill 取交集，最后保证含有 `load_skill`。  
**依赖：** 无。调用方传入工具名和 `SkillRecord`。

### `src/skills/load-tool.ts`

**职责：** 实现系统工具 `load_skill`。  
**对外接口：** 注册进现有 `ToolRegistry`。参数 `name`、可选 `args`。找到则 `activate`，返回替换后的正文和附属文件路径。找不到返回失败文本。共享模式不另开用户轮次，当前模型回合继续。独立模式改走执行器，工具结果就是摘要。  
**依赖：** `SkillSession`、`SkillCatalog`、执行器。

### `src/skills/slash.ts`

**职责：** 把目录里的 Skill 收成斜杠命令，并在热更新时换掉上一批。  
**对外接口：** `syncSkillCommands(commandRegistry, catalog)`。保留名 `clear`、`help`、`plan`、`do`、`compact`、`permission`、`session`、`memory`、`status` 不注册。其它名字覆盖内置命令。`CommandRegistry` 增加按名字卸下注册的能力，供这次同步使用。内置命令表不再注册原来的 `review`。  
**依赖：** 现有命令注册中心、执行器。

### `src/skills/run.ts`

**职责：** 按 `mode` 执行一次 Skill。  
**对外接口：** `runSkill(run: SkillRun)`。先 `activate`。共享模式调用现有 `submitToAgent` / 主循环，用户任务用 `args`，空参数时用「请按已激活的该 Skill 说明执行」。独立模式另开一段 Agent 循环，消息只有主会话最近 `history` 条加上这句任务，工具视图仍受白名单约束；结束时把最后一段助手正文追加进主会话，不写中间消息。指定了 `model` 时，在已配置的供应商里按模型名查找；找不到则这次执行失败并说明原因。  
**依赖：** `AgentLoop`、`SessionStore`、`SkillSession`、全部供应商配置。`runSkill` 接收「跑一段循环」的函数，避免和 `load_skill` 互相引用成环。

### 提示词与主循环

**职责：** 每轮重建环境提醒时，把 `pinnedText` 放在最前，其后是 `catalogText`，再是原来的工作区、时间和系统信息。稳定系统前缀不放 Skill 正文。主循环选工具时改经 `visibleToolNames`。共享模式下，请求使用的模型改为 `modelFor(sessionId)`，没有则仍用当前供应商模型。  
**依赖：** `src/prompt/reminder.ts`、`src/agent/loop.ts`。

### 对话门面、清屏与启动

**职责：** `ChatService.send` 在分发前调用 `refresh`。致命错误直接让进程以退出码 1 结束。刷新成功后 `syncSkillCommands`，解析警告送到现有警告通道。`/clear` 在清界面之外调用 `SkillSession.clear(sessionId)`。启动时在连上 MCP、工具表齐全之后做第一次 `refresh`，失败则退出。  
**依赖：** `src/chat/service.ts`、`src/commands/builtin/clear.ts`、`src/cli.ts`。

### 内置样板

**职责：** 在内置目录提供 `commit`、`review`、`test` 三份 `SKILL.md`。三者都是共享模式。`review` 的白名单只有 `read_file`、`glob_files`、`grep_search`。`commit` 和 `test` 的白名单是这三个再加上 `run_command`。正文里用 `$ARGUMENTS` 接用户补充说明。  
**依赖：** 只依赖目录解析，不依赖运行时代码。

## 模块交互

### 启动

`cli` 先装好工具表并连上 MCP，再把 `load_skill` 注册进去。然后 `SkillCatalog.refresh(当前全部工具名)`。抛出 `SkillFatalError` 时打印错误并 `exit(1)`。成功则 `syncSkillCommands`，解析警告并进现有警告列表，再启动界面。

### 回车

`ChatService.send` 在命令分发之前再次 `refresh`。致命错误同样 `exit(1)`。成功则 `syncSkillCommands`，让新 Skill 的短命令在这次回车生效。接着走现有分发：

- 空输入：不变，无副作用。
- 保留的会话控制命令：走原来的处理。`clear` 额外调用 `SkillSession.clear(sessionId)`。
- Skill 短命令：交给 `runSkill`。
- 未识别的 `/名字`：仍提示 `/help`，不进模型。
- 普通文本：进主循环。此时若已有激活 Skill，主循环按下面的每轮规则带上它们。

### 共享模式

`runSkill` 先 `activate(sessionId, name, args)`。用户任务是 `args`；`args` 为空时用「请按已激活的该 Skill 说明执行」。然后走 `submitToAgent`，不再做第二次斜杠解析。主循环把这句话写入主历史，模型回复也留在主历史。入口正文只出现在每轮提醒里，不写入存档。

### 独立模式

`runSkill` 同样先 `activate`。另开一段循环，输入只有主会话最近 `history` 条消息，再加上这句任务。这段循环使用该 Skill 自己的模型（未指定则用当前供应商模型），工具列表仍走 `visibleToolNames`。中间消息只留在这段循环的内存里。结束后取最后一段助手正文，作为一条助手消息追加到主会话。没有正文时，这条摘要说明该 Skill 已结束且没有文本结果。

模型在主循环里调用 `load_skill` 且该 Skill 是独立模式时，工具内部走同一条独立执行路径，工具结果文本就是摘要，摘要同样追加到主会话。

### 主循环每一轮

1. 用 `SkillSession.pinnedText` 取当前正文（已替换 `$ARGUMENTS`）。
2. 用 `SkillCatalog.catalogText` 取名字和一句话说明。
3. 拼进环境提醒，顺序是：已激活正文、Skill 目录、原有环境信息。
4. `visibleToolNames` 得到本轮工具。计划模式仍先限制为只读工具，再与白名单取交集，并始终留下 `load_skill`。
5. 模型名用 `modelFor(sessionId)`。找不到已配置供应商时，本轮停止并给出失败说明，不改用别的模型。

`load_skill` 若激活的是共享模式，只更新激活表并返回正文和附属文件路径，当前回合继续。

### 热更新与清屏

下一次回车的 `refresh` 会重新读磁盘。短命令、目录说明随之更新。已激活 Skill 的下一轮 `pinnedText` 用新正文。`/clear` 只清界面激活表，不改 JSONL，也不改磁盘上的 Skill 文件。新会话的激活表是空的。

## 文件组织

```
src/skills/
├── types.ts              — SkillRecord、SkillFatalError、SkillWarning、SkillRun
├── parse.ts              — frontmatter 与正文拆分
├── discover.ts           — 单层目录扫描，区分单文件与 SKILL.md 能力包
├── catalog.ts            — 三层合并、覆盖、致命校验、catalogText
├── session.ts            — 会话激活表、参数替换、pinnedText、modelFor
├── tools-view.ts         — visibleToolNames
├── load-tool.ts          — load_skill 工具
├── slash.ts              — 短命令同步，跳过保留名
├── run.ts                — 共享 / 独立执行
├── index.ts              — 对外导出
└── builtin/
    ├── commit/SKILL.md
    ├── review/SKILL.md
    └── test/SKILL.md

src/config/paths.ts       — 项目与用户 Skill 目录
src/commands/registry.ts  — 按名字卸下已注册命令
src/commands/types.ts     — 清屏时能清掉本会话激活
src/commands/builtin/clear.ts
src/commands/register-builtins.ts  — 不再注册原来的 review
src/tools/create-registry.ts       — 注册 load_skill
src/prompt/reminder.ts    — 提醒最前面放已激活正文和 Skill 目录
src/agent/loop.ts         — 工具视图、模型选择
src/chat/service.ts       — 回车前 refresh，接 runSkill
src/cli.ts                — 启动时 refresh，致命错误 exit(1)
docs/10-skills/plan.md
```

磁盘上的另外两级不进仓库：`<cwd>/.mewcode/skills`、`~/.mewcode/skills`。内置样板随源码放在 `src/skills/builtin`。

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 参数占位符 | 正文里的 `$ARGUMENTS`，全部替换；没有参数时换成空串 | 一种标记，多次出现行为一致，不做模板引擎 |
| 存放与覆盖 | 项目 > 用户 > 内置；同层重名立即退出；解析失败只跳过该 Skill | 和现有配置、权限的层级一致，致命错误和单点损坏分开 |
| 入口形态 | 目录根上的 `*.md` 是单文件；子目录里的 `SKILL.md` 是能力包，附属文件不再当成 Skill | 扫描只看一层，避免示例文档被误收录 |
| 两阶段内容放哪 | 名字、说明和已激活正文都放进每轮重建的环境提醒；已激活正文在最前。稳定系统前缀不放这些 | 每轮都在，且不把正文写进会话存档，也不打乱可缓存前缀 |
| 热更新 | 每次回车前 `refresh` 并 `syncSkillCommands`，不用文件监听 | 行为落在用户能观察到的下一次回车，实现简单 |
| 白名单 | 省略表示不参与收窄；写了的取交集；交集为空只留 `load_skill`；`load_skill` 永远留在列表里 | 多个 Skill 同时激活时仍然是收窄，系统工具不会被拿掉 |
| 未知工具 | 启动和回车前重扫都抛 `SkillFatalError`，进程退出码 1 | 和「立刻失败」一致，不把错误拖进对话 |
| 短命令 | 收录成功就注册。九个会话控制命令保留。原来的 `review` 内置命令删除，改由样板 Skill 提供 | 短命令在激活前就可用，又不会把清屏和帮助换掉 |
| 激活状态 | 只留在进程内的 `SkillSession`。`/clear` 清掉它，不改 JSONL | 符合清屏语义，重启或新会话自然是未激活 |
| 共享执行 | 激活后把参数送进当前主循环，空参数用一句固定任务 | 结果自然留在主历史，正文仍只在提醒里 |
| 独立执行 | 另开循环，只带最近 N 条主历史；只把最后一段助手正文写回主会话。`load_skill` 遇到独立模式时走同一条路径 | 中间过程不进主存档，工具调用和短命令行为一致 |
| 指定模型 | 按已配置供应商的模型名查找。找不到就让这次执行失败 | 不静默换模型 |
| 权限 | 工具视图只决定模型能不能看见工具，执行前仍走现有权限闸门 | 白名单不是第二套权限 |
| 模块依赖 | `runSkill` 接收「跑一段循环」的函数，`load_skill` 再调用 `runSkill` | 避免执行器和工具实现互相引用成环 |
| 内置样板 | `commit`、`test` 白名单为三个只读工具加 `run_command`；`review` 只有三个只读工具。三者都是共享模式 | 审查不能改仓库；提交和测试需要跑命令 |

## Spec 覆盖

| 需求 | 归属 |
|------|------|
| F1–F4 | `parse.ts`、`$ARGUMENTS` 替换 |
| F5、F8 | `discover.ts` 能力包与附属文件 |
| F6、F7 | `catalog.ts` 三层合并与致命错误 |
| F9、F11 | 环境提醒中的目录说明与 `pinnedText` |
| F10、F12 | `load_skill` 与 `slash.ts` |
| F13、F14 | `run.ts` 共享 / 独立 |
| F15 | `modelFor` 与供应商查找 |
| F16–F18 | `tools-view.ts`、`load_skill` 常驻 |
| F19 | 现有权限闸门保持在执行前 |
| F20 | 回车前 `refresh` + `syncSkillCommands` |
| F21 | 保留名 + 移除内置 `review` 命令 |
| F22 | `src/skills/builtin/*/SKILL.md` |
