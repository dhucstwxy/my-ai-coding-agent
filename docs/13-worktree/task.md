# Git Worktree 隔离 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/worktree/types.ts` | WorktreeInfo、DirtyState 等 |
| 新建 | `src/worktree/name.ts` | validateName、规范化、分支名映射 |
| 新建 | `src/worktree/git.ts` | git worktree / status / 未推送 |
| 新建 | `src/worktree/init.ts` | 固定规则环境初始化 |
| 新建 | `src/worktree/service.ts` | WorktreeService 生命周期与活跃表 |
| 新建 | `src/worktree/janitor.ts` | 过期清理 |
| 新建 | `src/worktree/index.ts` | 导出 |
| 修改 | `src/config/paths.ts` | `projectWorktreesDir` |
| 修改 | `.gitignore` | 忽略 `.mewcode/worktrees/` |
| 修改 | `src/agents/types.ts` | `isolation`、任务上的 worktree 字段 |
| 修改 | `src/agents/catalog.ts` | 解析 `isolation: worktree` |
| 修改 | `src/agents/run.ts` | 启动/结束时接入 Worktree |
| 修改 | `src/chat/service.ts` | 注入 WorktreeService |
| 修改 | `src/cli.ts` | 构造服务、启动/停止 janitor |

## T1: 类型与路径

**文件：** `src/worktree/types.ts`、`src/config/paths.ts`、`.gitignore`  
**依赖：** 无  
**步骤：**
1. 定义 `WorktreeInfo`、`DirtyState`，字段与 plan 一致
2. 在 `paths.ts` 增加 `projectWorktreesDir(cwd)` → `<cwd>/.mewcode/worktrees`
3. `.gitignore` 增加 `.mewcode/worktrees/`

**验证：** `npm run typecheck`；确认 `projectWorktreesDir("/tmp/repo")` 以 `.mewcode/worktrees` 结尾

## T2: 目录名校验与分支名

**文件：** `src/worktree/name.ts`  
**依赖：** T1  
**步骤：**
1. 实现 `validateName`：单段 `[a-zA-Z0-9._-]`，总长 ≤ 64，段数 ≤ 4，禁止 `.`/`..` 段，用 `/` 嵌套；失败返回 reason
2. 实现规范化（统一分隔符）与 `toBranchName(name)` → `mew/<safe>`（`/` 替换为约定安全字符，如 `__`）
3. 实现 `generateAgentWorktreeName(roleName: string): string` → `agents/<roleName>-<8hex>`，生成后仍校验

**验证：** 用脚本断言：`../x`、`a/../../b`、超长、非法字符失败；`agents/foo-deadbeef` 成功；分支名不含原样 `/` 嵌套风险。脚本删。`npm run typecheck`

## T3: Git 驱动

**文件：** `src/worktree/git.ts`  
**依赖：** T1、T2  
**步骤：**
1. 封装在 `repoRoot` 下执行 git（继承 stdio 文本），统一超时与错误文案
2. 实现 `worktreeAdd(repoRoot, absPath, branch)`：从当前 HEAD `git worktree add -b <branch> <absPath>`
3. 实现 `worktreeRemove(repoRoot, absPath)`、`worktreeList(repoRoot)`
4. 实现 `statusPorcelain(worktreePath)`、`hasUnpushed(worktreePath, baselineSha?)`（无上游时用 baseline 与 HEAD 比较）

**验证：** 在临时 git 仓库调用 add 后目录存在且 `git worktree list` 含该路径；remove 后消失。脚本清理临时仓。`npm run typecheck`

## T4: 环境初始化

**文件：** `src/worktree/init.ts`  
**依赖：** T1  
**步骤：**
1. 实现 `initializeWorktree(repoRoot, worktreePath)`：按 plan 复制三份本地配置（源存在且目标不存在才复制）
2. 配置 hooks（使 worktree 内 git 能用到与主区一致的 hooksPath）
3. 主区有 `node_modules` 且目标无该入口时建立软链；失败抛错（交给上层回滚）
4. 实现「只补缺失」语义，已存在文件/软链不破坏性覆盖

**验证：** 临时目录模拟主区配置与 `node_modules`，初始化后目标侧文件与软链存在；再跑一次不覆盖已改内容。软链失败时函数失败。`npm run typecheck`

## T5: WorktreeService

**文件：** `src/worktree/service.ts`、`src/worktree/index.ts`  
**依赖：** T2、T3、T4  
**步骤：**
1. 实现 `create`：校验 → 目录已存在则快速恢复（不调 add）并 `initializeWorktree` 补缺失 → 否则 add + init；失败尽量 remove/回滚
2. 实现 `enter` / `exit` / `markUsed`：维护活跃集合与 `lastUsedAt`（可写在内存 Map；进程内即可）
3. 实现 `isDirty` → `DirtyState`；`remove` 在 `blocked` 时拒绝；目录已不存在则成功
4. 实现 `list`；导出 `index.ts`

**验证：** 临时仓：create → enter → 路径正确且 `process.cwd()` 未变；二次 create 为 `created: false`；脏工作区 remove 抛错/返回失败；干净可删。`npm run typecheck`

## T6: 过期清理

**文件：** `src/worktree/janitor.ts`  
**依赖：** T5  
**步骤：**
1. 实现 `startWorktreeJanitor(service, opts?)`：默认 interval 1h、ttl 7d；返回 `{ stop() }`
2. 扫描时：未超 ttl 跳过；活跃跳过；`blocked` 跳过；name/路径不安全跳过；否则 `remove`
3. 测试可用缩短 interval/ttl 的 opts

**验证：** 用极短 ttl、非活跃且干净的假目录（或 service 登记项）跑一轮后被删；标活跃或制造未提交修改的不被删。`stop` 后不再调度。`npm run typecheck`

## T7: 角色 isolation 字段

**文件：** `src/agents/types.ts`、`src/agents/catalog.ts`  
**依赖：** 无（可与 T1–T6 并行）  
**步骤：**
1. `AgentRecord` 增加可选 `isolation?: "worktree"`
2. `SubAgentTask` 增加可选 `worktreeName?`、`worktreePath?`
3. catalog 解析：`isolation` 缺省忽略；值为 `worktree` 则写入；其他值警告并跳过该角色

**验证：** 临时角色文件：合法 `isolation: worktree` 可读出；`isolation: foo` 被跳过且有警告。`npm run typecheck`

## T8: 子 Agent 启动接入

**文件：** `src/agents/run.ts`  
**依赖：** T5、T7  
**步骤：**
1. `SubAgentDeps` 增加可选 `worktrees?: WorktreeService`（主仓服务）
2. 定义式且 `role.isolation === "worktree"`：生成 name → `create` → `enter`；失败则不建任务，返回失败 ToolResult
3. 将 `worktreePath` 写入 task；`new AgentLoop(..., worktreePath ?? deps.workspaceRoot, ...)`
4. 在子 Agent 系统侧可见说明中注入隔离绝对路径（定义式可拼进首次用户消息前缀或 system 附加段，选一种并保持简单）
5. Fork / 无 isolation 不调用 worktree

**验证：** `npm run typecheck`；用假 WorktreeService 或临时仓：带 isolation 的启动路径会 create/enter；无 isolation 不调用

## T9: 子 Agent 结束清理

**文件：** `src/agents/run.ts`  
**依赖：** T8  
**步骤：**
1. 在 `runChild` 的 `finally`（在已有清理之后）若有 `worktreeName`：`exit`；`isDirty` 若 `blocked` 则保留；否则 `remove`
2. `remove` 失败只 `console.error`（或现有日志），不影响最终答复送回
3. 确保父会话仍能收到结果（与现有 finish/enqueue 顺序兼容）

**验证：** `npm run typecheck`；临时仓脚本：隔离目录内无改动结束 → 目录删除；有未提交改动 → 目录保留

## T10: CLI / ChatService 装配

**文件：** `src/chat/service.ts`、`src/cli.ts`  
**依赖：** T6、T8  
**步骤：**
1. 在 cli 用 `workspaceRoot` 构造 `WorktreeService`，`startWorktreeJanitor`，把 service 注入 ChatService / `subAgentDeps`
2. 进程退出路径调用 `janitor.stop()`（与现有 `clearParent` 等同级）
3. ChatService 的 `subAgentDeps()` 带上 `worktrees`

**验证：** `npm run typecheck`；启动进程不报错（可只 typecheck + 短时启动再退出，若环境允许）

## T11: 缓存键审计

**文件：** 按审计触及的文件（预期改动少或无）  
**依赖：** T8  
**步骤：**
1. 审计 read/instructions/memory/prompt 是否存在相对路径缓存键
2. 若有，改为绝对路径；若无，在 task 完成说明里记「已审计，现有逻辑均按传入的绝对 workspaceRoot 隔离」
3. 确认子循环换根后，主区与隔离区同相对路径读写互不覆盖（依赖工具 resolve，不新增全局 chdir）

**验证：** `npm run typecheck`；可选：主区与 worktree 各写同相对路径文件，内容不同且均存在

## 执行顺序

```
T1 → T2 → T3 → T4 → T5 → T6
                ↘
T7（可并行）─────→ T8 → T9 → T10
                         ↘
                          T11
```
