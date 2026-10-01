# Git Worktree 隔离 Plan

## 架构概览

本步在子 Agent 旁增加一套与委派解耦的 Worktree 能力：用 Git 多工作目录在 `.mewcode/worktrees/<name>/` 下落独立目录，再通过「子循环换 `workspaceRoot`」把文件操作绑到该绝对路径。不调用 `process.chdir`。现有工具已通过 `ToolContext.workspaceRoot` 接收显式根路径，多数工具无需再改签名。

| 组件 | 职责 |
|------|------|
| **Name 校验** | 校验 `<name>`：字符集、长度、禁止 `.`/`..` 段、允许 `/` 嵌套。失败则拒绝后续操作。 |
| **Git Worktree 驱动** | 封装 `git worktree add/remove/list` 等；从主区 HEAD 建 `mew/<name>` 分支；已存在则只读恢复。 |
| **环境初始化** | 固定规则：复制本地配置、配置该目录 hooks、软链大型依赖、按规则补齐被忽略文件；快速恢复时只补缺失。 |
| **变更检测** | 判断隔离目录是否有未提交修改或未推送本地 commit，供删除保护与结束后去留。 |
| **Worktree 服务** | 对外生命周期：`create`（含恢复）、`enter`（返回绝对路径绑定）、`exit`、`remove`；登记活跃使用与最近使用时间。 |
| **过期清理** | 定期扫描 `.mewcode/worktrees/`，7 天未使用 + 三层过滤后删除。 |
| **子 Agent 接入** | 解析 `isolation: worktree`；启动时自动生成 name、create/enter、子循环 `workspaceRoot` 指向隔离绝对路径并注入路径说明；结束时按变更 remove 或保留。 |
| **缓存键** | 文件内容 / 系统提示 / 项目指令 / 记忆等路径相关缓存以绝对路径为键。 |

数据流（隔离定义式）：

```
角色 isolation: worktree
  → 生成合法 name（如 agents/<role>-<id>）
  → Worktree 服务 create（或快速恢复）+ 环境初始化
  → enter → 得到绝对路径 cwd
  → 子循环 / 工具 ctx.workspaceRoot = cwd
  → 结束 → 变更检测 → 干净则 remove，否则保留
  → 删除失败只记日志，最终结果仍回父会话
```

主区与未声明 / Fork 子 Agent 仍使用原来的主 `workspaceRoot`。

## 核心数据结构

### WorktreeName

逻辑名，相对 `.mewcode/worktrees/`。

- 校验通过后的规范化字符串（内部用 `/` 分段）
- 单段字符集 `[a-zA-Z0-9._-]`，总长度上限 64，段数上限 4；任一段不得为 `.` 或 `..`

### WorktreeInfo

- `name: string` — 逻辑名
- `path: string` — 隔离目录绝对路径
- `branch: string` — 检出分支（如 `mew/<name>`，`<name>` 中的 `/` 按约定替换为合法分支名片段）
- `created: boolean` — 本次是否新建（`false` 表示快速恢复）

### DirtyState

- `uncommitted: boolean` — `git status --porcelain` 非空
- `unpushed: boolean` — 相对上游有未推送 commit；无上游时，相对创建基线（主区当时 HEAD）有新 commit 也视为 true
- `blocked: boolean` — `uncommitted || unpushed`

### WorktreeService

构造参数：`repoRoot`（主工作区绝对路径）。

- `validateName(name: string): { ok: true; name: string } | { ok: false; reason: string }`
- `create(name: string): Promise<WorktreeInfo>` — 校验 → 已存在则快速恢复并补齐初始化 → 否则 `git worktree add -b` + 初始化；失败按 N5 尽量回滚
- `enter(name: string): WorktreeInfo` — 校验且目录可用则返回 info，标记活跃并更新最近使用时间；不 `chdir`
- `exit(name: string): void` — 取消活跃标记（最近使用时间保留）
- `remove(name: string): Promise<void>` — 变更保护通过后移除 worktree 与目录；已不存在则成功返回
- `isDirty(name: string): Promise<DirtyState>`
- `list(): Promise<WorktreeInfo[]>` — 仅 `.mewcode/worktrees/` 下已登记项
- `markUsed(name: string): void`

### 环境初始化规则（固定）

- **复制（主区存在才复制，目标已存在不覆盖）：** `.mewcode/config.yaml`、`.mewcode/permissions.local.yaml`、`.mewcode/hooks.local.yaml`
- **Hooks：** 使该 worktree 内 git 操作能跑到与主区一致的 hooks（例如设置 `core.hooksPath` 或等价配置）
- **软链（主区存在且目标缺失时建立）：** `node_modules`
- **补齐被忽略文件：** 与上列复制清单相同；清单外本步不扩展

### AgentRecord 扩展

- `isolation?: "worktree"` — 仅当元信息为该字面量时设置；其他值视为无效，读取时跳过该角色并警告

### 自动生成 name

- 格式：`agents/<roleName>-<shortId>`，`shortId` 为 8 位小写十六进制
- 生成后仍走 `validateName`；碰撞则换 `shortId` 重试有限次

### SubAgentTask 扩展

- `worktreeName?: string`
- `worktreePath?: string`

子循环构造时：若有 `worktreePath`，则 `AgentLoop` / `ToolContext.workspaceRoot` / 权限与指令加载均用该路径；并向子 Agent 注入工作区路径说明（不暴露可改的 name 参数）。

### 过期清理

- `startWorktreeJanitor(service, opts?): { stop(): void }`
- 默认每小时扫一次；`now - lastUsedAt > 7d` 才候选；过滤活跃、`blocked`、非法路径后再 `remove`

## 模块设计

### `src/worktree/name.ts`

**职责：** `validateName`、规范化、分支名映射。  
**依赖：** 无。

### `src/worktree/git.ts`

**职责：** 调用本机 `git`：`worktree add -b`、`worktree remove`、`worktree list`、`status --porcelain`、上游 / `rev-list` 判断未推送。  
**对外：** 结构化结果或错误文案。  
**依赖：** `node:child_process`、主仓库绝对路径。

### `src/worktree/init.ts`

**职责：** 固定规则环境初始化；快速恢复只补缺失。  
**依赖：** `fs`、必要时 `git`。

### `src/worktree/service.ts`

**职责：** `WorktreeService` 生命周期、活跃表、`lastUsedAt`。  
**依赖：** name / git / init；`repoRoot`。

### `src/worktree/janitor.ts`

**职责：** 定时扫描与三层过滤清理。  
**依赖：** `WorktreeService`。

### `src/worktree/types.ts` / `index.ts`

**职责：** 类型定义与导出。

### 接入改动

| 模块 | 改动 |
|------|------|
| `config/paths.ts` | `projectWorktreesDir(cwd)` → `.mewcode/worktrees` |
| `.gitignore` | 忽略 `.mewcode/worktrees/` |
| `agents/types.ts` | `isolation?`；`SubAgentTask` 可选 worktree 字段 |
| `agents/catalog.ts` | 解析 `isolation: worktree`；非法值警告跳过 |
| `agents/run.ts` | 定义式且 isolation 时 create/enter；子循环换根；注入路径说明；结束时 exit + 条件 remove |
| `chat/service.ts` / `cli.ts` | 构造 `WorktreeService` 注入 deps；启动 janitor，退出时 `stop` |
| 路径缓存相关 | 相对键改为绝对路径键 |

## 模块交互

```
cli
  ├─ WorktreeService(repoRoot)
  ├─ startWorktreeJanitor(service)
  └─ ChatService → startSubAgent(deps + worktrees)

startSubAgent（defined + isolation: worktree）
  → generateName(role)
  → service.create(name)
  → info = service.enter(name)
  → childLoop.workspaceRoot = info.path
  → finally:
       service.exit(name)
       if !dirty → service.remove(name)  // 失败只 log

主 Agent / fork / 无 isolation
  → workspaceRoot 始终为 repoRoot
```

工具层保证子循环传入正确的 `ToolContext.workspaceRoot` 即可满足显式 cwd（F7）。

## 文件组织

```
src/worktree/
├── name.ts       — validateName、规范化、分支名映射
├── git.ts        — git worktree / status / 未推送检测
├── init.ts       — 固定规则环境初始化
├── service.ts    — WorktreeService 生命周期与活跃表
├── janitor.ts    — 过期清理
├── types.ts      — WorktreeInfo、DirtyState 等
└── index.ts      — 导出

修改：
├── src/config/paths.ts
├── src/agents/types.ts
├── src/agents/catalog.ts
├── src/agents/run.ts
├── src/chat/service.ts
├── src/cli.ts
├── .gitignore
└── 路径缓存相关文件（按审计结果）

docs/13-worktree/
├── spec.md
├── plan.md
├── task.md
└── checklist.md
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 隔离机制 | Git worktree，目录在 `.mewcode/worktrees/` | 同仓多目录、共享对象库；符合 spec |
| 切换方式 | 不 `chdir`，子循环换 `workspaceRoot` | 工具已支持显式根；并行子 Agent 不抢全局 cwd |
| name 来源 | 系统生成 `agents/<role>-<id>` | 防路径遍历；模型不可见 |
| 已存在策略 | 快速恢复，不重复 `worktree add` | 满足 F3 |
| 无上游时的「未推送」 | 相对创建基线 HEAD 有新 commit 即不可删 | 避免只本地提交被当成可删 |
| 初始化失败 | 创建失败并尽量回滚 | 对齐 N5 |
| 软链失败 | 不拷贝整棵 `node_modules` | 对齐「不做的事」 |
| 过期 | 固定 7 天 + 每小时扫描 | 本步不做可配置 |
| 合并 | 本步不做 | 留给上层 `git merge` |

### spec 覆盖

| F | 归属 |
|---|------|
| F1–F5 | name + git + service |
| F6 | init |
| F7–F8 | 子循环 workspaceRoot + 缓存键绝对路径 |
| F9–F11 | catalog isolation + run 接入 |
| F12–F13 | dirty + remove + janitor |
