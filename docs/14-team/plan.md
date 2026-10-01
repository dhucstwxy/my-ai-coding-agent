# Team Lead 与长期小组 Plan

## 架构概览

本步在子 Agent 与 Worktree 之上增加长期小组能力。主对话默认作为 Lead，获得建组、派人、任务、消息与合并工具；队员获得协作工具子集。协作工具通过视图过滤，对普通子 Agent 委派不可见。进程内最多一个活跃小组；持久化落在用户目录。

| 组件 | 职责 |
|------|------|
| **TeamStore** | 用户目录下按小组名读写元数据与花名册；创建/恢复/停用/解散；维护唯一活跃小组 |
| **Mailbox** | 邮箱文件 + 锁文件；发送/广播/已读；过期锁抢占 |
| **TeamTaskStore** | 共享任务增删查改与持久化（与进程内子 Agent `TaskBoard` 分离） |
| **BackendProbe / Runtime** | 探测窗格能力；选择 `pane` 或 `inprocess`；失败不降级；窗格唤醒 |
| **MemberRunner** | 启动/恢复/终止队员；绑定 Worktree 或主区；空闲通知；上下文落盘与恢复 |
| **ApprovalGate** | 需审批队员在获批前拦截写类工具 |
| **MergeService** | git 合并成员目录；冲突则回滚并返回说明 |
| **TeamToolViews** | Lead / 队员工具集划分；从普通 `agent` 视图排除协作工具 |
| **Coordinator** | 配置开关 + 环境变量双锁；生效时从 Lead 视图去掉写文件类工具 |

数据流：

```
用户 ↔ Lead（主循环 + Lead 工具）
         ├─ TeamStore.create/resume
         ├─ spawn MemberRunner（probe → pane|inprocess + worktree）
         ├─ TeamTaskStore / Mailbox
         └─ MergeService → 主区

队员 ↔ 协作工具（任务 + 邮箱）
         └─ 空闲 → 邮件通知 Lead；再收信 → 恢复上下文
```

## 核心数据结构

### 路径约定

- 小组根：`~/.mewcode/teams/<teamName>/`
- `team.json` — 元数据与花名册
- `tasks.json` — 共享任务
- `registry.json` — 名称 → 邮箱路径 / 后端句柄
- `mail/<memberName>.json` — 邮箱（JSON 数组）
- `mail/<memberName>.lock` — 锁文件
- `members/<memberName>/session/` — 队员上下文快照

### TeamRecord

- `name: string`
- `leadName: string`
- `rootPath: string`
- `members: MemberRecord[]`
- `createdAt` / `updatedAt: string`（ISO）

### MemberRecord

- `name: string`
- `role: string`
- `workdir: "worktree" | "main"`（默认 `worktree`）
- `worktreeName?: string`
- `backend: "pane" | "inprocess"`
- `backendHandle?: string`
- `requiresApproval: boolean`
- `status: "running" | "idle" | "stopped"`
- `approved: boolean`

### TeamTask

- `id: string`
- `title: string`
- `description?: string`
- `dependsOn: string[]`
- `assignee?: string`
- `status: "open" | "done" | "cancelled"`

### MailMessage

- `id: string`
- `from: string`
- `body: string`
- `timestamp: string`
- `read: boolean`
- `summary: string`
- `type?: "idle" | "plan" | "approve" | "reject" | "text"`

### TeamStore

- `create(name): TeamRecord`
- `resume(name): TeamRecord`
- `deactivate(): void`
- `disband(): void`
- `active(): TeamRecord | null`
- `upsertMember` / `getMember` / `listMembers`

### Mailbox

- `send(to, msgDraft): MailMessage`
- `broadcast(from, draft): void`
- `list(member)` / `markRead(member, id)`
- 内部 `withLock`：重试；锁 mtime 超过 10s 可抢占

### TeamTaskStore

- `list` / `add` / `update` / `remove`

### BackendProbe

- `detect(): { pane: boolean; inprocess: boolean }`
- `select(): "pane" | "inprocess"` — 窗格优先；选中不可用则抛错（文案含后端名）
- `wake(handle): boolean` — 尽量唤醒；失败不撤销已写入邮件

### MemberRunner

- `spawn(team, memberSpec): MemberRecord`
- `resume(team, memberName, wakeMessage): void`
- `stop(team, memberName): void`
- 自然空闲 → `status=idle` + 向 Lead 发 `type:idle`

### ApprovalGate

- `requiresApproval && !approved` 时拒绝 `write_file` / `edit_file`（及约定写类）
- 处理 plan / approve / reject 邮件以更新 `approved`

### MergeService

- `mergeMemberWorktrees(team, memberNames[]): { ok: boolean; message: string }`

### Coordinator

- 配置：`AppConfig.teams?.coordinatorAvailable?: boolean`（默认 false）
- 环境变量：`MEWCODE_COORDINATOR=1`
- `isActive(): boolean` — 两把锁都开
- Lead 视图：active 时去掉 `write_file` / `edit_file`，保留读类、`run_command`、团队工具

### 工具划分

**Lead：** `team_create`、`team_disband`、`team_spawn`、`team_stop`、`team_message`、`team_task_*`、`team_merge`  
**队员：** `team_task_*`、`team_message`  
普通 `agent` 子 Agent：不含任何 `team_*`。

## 模块设计

### `src/team/types.ts`

**职责：** 核心类型。  
**依赖：** 无。

### `src/team/paths.ts`

**职责：** 用户目录路径、小组名校验。  
**依赖：** `os` / `path`。

### `src/team/store.ts`

**职责：** 小组生命周期与花名册持久化；进程内唯一活跃。  
**依赖：** paths、types。

### `src/team/mailbox.ts`

**职责：** 加锁读写邮箱。  
**依赖：** paths、registry。

### `src/team/tasks.ts`

**职责：** `tasks.json` CRUD。  
**依赖：** paths。

### `src/team/registry.ts`

**职责：** 名称注册表。  
**依赖：** paths。

### `src/team/backend.ts`

**职责：** 探测、选择、tmux 窗格适配（有则用）、唤醒。  
**依赖：** 环境。

### `src/team/runner.ts`

**职责：** spawn / resume / stop / 空闲。  
**依赖：** backend、WorktreeService、AgentLoop（或 pane 子进程）、mailbox、store。

### `src/team/approval.ts`

**职责：** 写类拦截与审批状态。  
**依赖：** store、mailbox。

### `src/team/merge.ts`

**职责：** git 合并与冲突回滚。  
**依赖：** git、worktree 路径。

### `src/team/coordinator.ts`

**职责：** 双锁。  
**依赖：** config、`process.env`。

### `src/team/views.ts` + `src/team/tools/*`

**职责：** 工具实现与 Lead/队员视图。  
**依赖：** 上列各模块。

### 接入改动

| 模块 | 改动 |
|------|------|
| `config/types.ts` + load/validate | `teams.coordinatorAvailable` |
| `chat/service.ts` / loop 工具列表 | base ∪ leadTools（经 coordinator 过滤） |
| `agents/tools.ts` 或 `run.ts` | 普通子 Agent 排除 `team_*` |
| `cli.ts` | 装配 TeamStore、Coordinator、注入 |
| `prompt/reminder` 或 environment | 活跃小组、双锁状态 |

## 模块交互

```
cli
  → TeamStore + WorktreeService + Coordinator
  → ChatService（tools = base ∪ leadTools(coord)）

Lead: team_create / spawn / ...
  → store / runner.spawn
       → backend.select()
       → worktree.create（若 workdir=worktree）
       → registry + mailbox
       → pane 或 inprocess 循环（member tools + ApprovalGate）

队员空闲 → mail(type=idle) → Lead
Lead: team_message → send →（pane 则 wake）→ idle 则 resume
Lead: team_merge → merge.ts
普通 agent → 无 team_*
```

## 文件组织

```
src/team/
├── types.ts
├── paths.ts
├── store.ts
├── mailbox.ts
├── tasks.ts
├── registry.ts
├── backend.ts
├── runner.ts
├── approval.ts
├── merge.ts
├── coordinator.ts
├── views.ts
├── tools/
│   ├── create.ts
│   ├── spawn.ts
│   ├── stop.ts
│   ├── message.ts
│   ├── task.ts
│   ├── merge.ts
│   └── disband.ts
└── index.ts

docs/14-team/
├── spec.md
├── plan.md
├── task.md
└── checklist.md
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 持久化位置 | `~/.mewcode/teams/<name>/` | 用户目录按小组名；与项目仓解耦 |
| 活跃小组 | 进程内单例 | 对齐同时一个活跃 |
| 邮箱格式 | JSON 数组 + `.lock`；锁过期 10s | 实现简单、可测 |
| 窗格后端 | 优先 tmux；否则 inprocess | 可自动化；无能力不装假窗格 |
| 任务存储 | `TeamTaskStore` 独立于 `TaskBoard` | 避免命名与生命周期混淆 |
| 队员循环 | inprocess 用 AgentLoop + 快照目录；pane 起完整实例共享 team 根 | 满足强隔离与轻量两条路径 |
| 工具可见性 | views 过滤；`agent` 排除全部 `team_*` | 满足 F10 |
| Coordinator | `teams.coordinatorAvailable` + `MEWCODE_COORDINATOR=1` | 双锁 |
| 合并冲突 | `git merge --abort`（或等价）并上报 | 对齐 F18 |
| 依赖字段 | 只存不调度 | 对齐不做的事 |

### spec 覆盖

| F | 归属 |
|---|------|
| F1–F4 | store + paths + types |
| F5–F8 | backend + runner + worktree |
| F9–F11 | tools + views |
| F12–F13 | approval + mailbox |
| F14–F17 | mailbox + registry + wake |
| F18–F19 | tasks + merge |
| F20–F21 | coordinator + views |
