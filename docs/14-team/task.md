# Team Lead 与长期小组 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/team/types.ts` | 核心类型 |
| 新建 | `src/team/paths.ts` | 路径与小组名校验 |
| 新建 | `src/team/store.ts` | 小组生命周期 |
| 新建 | `src/team/mailbox.ts` | 邮箱 + 锁 |
| 新建 | `src/team/tasks.ts` | 共享任务 |
| 新建 | `src/team/registry.ts` | 名称注册表 |
| 新建 | `src/team/backend.ts` | 后端探测/选择/唤醒 |
| 新建 | `src/team/approval.ts` | 审批闸门 |
| 新建 | `src/team/merge.ts` | git 合并与回滚 |
| 新建 | `src/team/coordinator.ts` | 双锁 |
| 新建 | `src/team/runner.ts` | 派生/恢复/终止/空闲 |
| 新建 | `src/team/views.ts` | Lead/队员工具视图 |
| 新建 | `src/team/tools/*.ts` | team_* 工具 |
| 新建 | `src/team/index.ts` | 导出 |
| 修改 | `src/config/types.ts` 等 | `teams.coordinatorAvailable` |
| 修改 | `src/chat/service.ts` / `cli.ts` | 装配 Lead 工具与 Team 运行时 |
| 修改 | `src/agents/tools.ts` 或 `run.ts` | 排除 team_* |
| 修改 | `src/prompt/reminder.ts` 或 environment | 活跃小组与双锁提示 |

## T1: 类型与路径

**文件：** `src/team/types.ts`、`src/team/paths.ts`  
**依赖：** 无  
**步骤：**
1. 定义 TeamRecord、MemberRecord、TeamTask、MailMessage，字段与 plan 一致
2. 实现 `userTeamsDir`、`teamRoot`、mail/tasks/registry/session 路径辅助函数
3. 实现 `validateTeamName`：限字符集与长度，拒绝 `.`/`..` 与路径分隔符滥用

**验证：** `npm run typecheck`；非法名返回失败原因

## T2: TeamStore

**文件：** `src/team/store.ts`  
**依赖：** T1  
**步骤：**
1. 实现 create：写 `team.json` 空花名册；已存在则 resume 不清空 tasks/mail
2. 实现唯一活跃：create/resume 另一组前须 deactivate 当前
3. 实现 disband：停运行态钩子可先空实现，删除小组目录；active 变 null
4. upsertMember / getMember / listMembers / active

**验证：** 临时 HOME 下 create→resume 保留文件；双活跃被拒绝或自动要求先 deactivate；disband 后目录不存在。脚本删

## T3: 注册表与邮箱锁

**文件：** `src/team/registry.ts`、`src/team/mailbox.ts`  
**依赖：** T2  
**步骤：**
1. registry：名称 ↔ 邮箱路径 / backendHandle 读写 `registry.json`
2. mailbox：send 补 timestamp、read=false、summary；list/markRead
3. withLock：拿不到锁重试；mtime>10s 可抢占；broadcast 写所有其他成员+lead

**验证：** 并发两次 send 不损坏文件且都能读到；过期锁可写入。`npm run typecheck`

## T4: 共享任务

**文件：** `src/team/tasks.ts`  
**依赖：** T2  
**步骤：**
1. list/add/update/remove，持久化 `tasks.json`
2. 支持 `dependsOn` 数组字段（不做调度）

**验证：** 增改删后重启读盘一致。脚本删

## T5: Coordinator 与配置

**文件：** `src/team/coordinator.ts`、`src/config/types.ts`、load/validate  
**依赖：** 无（可与 T1–T4 并行）  
**步骤：**
1. AppConfig 增加可选 `teams?: { coordinatorAvailable?: boolean }`
2. `isCoordinatorActive(config)`：available 且 `MEWCODE_COORDINATOR` 为真值（如 `1`/`true`）
3. 缺省 available=false

**验证：** 四种开关组合断言；仅双开为 true。`npm run typecheck`

## T6: Backend 探测

**文件：** `src/team/backend.ts`  
**依赖：** 无  
**步骤：**
1. detect：tmux 可用则 pane=true；inprocess 恒 true
2. select：pane 优先；若强制模拟 pane 失败路径则抛错且文案含后端名，不改选 inprocess
3. wake(handle)：tmux 选中窗格；失败返回 false

**验证：** 无 tmux 时 select 得 inprocess；注入「pane 被选但不可用」时失败不降级。`npm run typecheck`

## T7: ApprovalGate

**文件：** `src/team/approval.ts`  
**依赖：** T2、T3  
**步骤：**
1. `assertWritable(member)`：需审批且未 approved → 拒绝
2. 处理邮件类型：plan 不改写权限；approve 置 approved=true；reject 置 false
3. 导出写类工具名集合（write_file、edit_file）

**验证：** 未批准时 assert 失败；approve 后通过；reject 再失败。脚本删

## T8: MergeService

**文件：** `src/team/merge.ts`  
**依赖：** T2、现有 worktree/git  
**步骤：**
1. 对指定成员 worktree 分支合并进主区当前分支
2. 成功返回 ok；冲突则 abort 回滚并 message 说明

**验证：** 临时双 worktree 无冲突合并成功；制造冲突见回滚。`npm run typecheck`

## T9: MemberRunner（inprocess 优先）

**文件：** `src/team/runner.ts`  
**依赖：** T2–T4、T6、T7、WorktreeService  
**步骤：**
1. spawn：select 后端；workdir=worktree 则 create/enter；写 registry；inprocess 启动独立 session 循环（可先最小：能跑完一轮工具并在结束时 idle+通知）
2. pane 路径：若 select 为 pane，启动方式按 backend 适配；不可用则失败（不降级）
3. stop：取消循环/关窗格；status=stopped|idle
4. resume：读 session 快照，附加 wake 消息继续；失败不新建同名条目
5. 自然结束 → idle + type:idle 邮件给 Lead

**验证：** inprocess spawn→空闲邮件存在；resume 不新增花名册行；tmux 缺失时 pane 强制失败文案正确。`npm run typecheck`

## T10: 工具与视图

**文件：** `src/team/views.ts`、`src/team/tools/*.ts`、`src/team/index.ts`  
**依赖：** T2–T9  
**步骤：**
1. 实现 Lead 工具：create/disband/spawn/stop/message/task_*/merge
2. 队员工具：task_*、message（含广播与结构化 type）
3. `leadToolDefinitions(coord)` / `memberToolDefinitions()`；`isTeamTool(name)`
4. coordinator active 时 Lead 定义中不含 write_file/edit_file（若写工具在 base 侧过滤，则在 views 提供 `filterBaseToolsForLead(base, coord)`）

**验证：** Lead 工具名集合含 merge；队员不含 spawn；isTeamTool 识别。`npm run typecheck`

## T11: 接入主循环与子 Agent

**文件：** `src/chat/service.ts`、`src/cli.ts`、`src/agents/tools.ts` 或 `run.ts`、prompt 提醒  
**依赖：** T5、T10  
**步骤：**
1. cli 构造 TeamStore、Coordinator、注入 ChatService
2. 主循环发给模型的工具 = base（经 coord 过滤）∪ lead team 工具
3. 普通 agent 子 Agent visibleTools 排除全部 team_*
4. 环境提醒展示活跃小组名与 coordinator 双锁是否生效

**验证：** `npm run typecheck`；断言子 Agent 工具列表无 team_create；coord 双开时主视图无 write_file

## T12: 端到端脚本（无模型）

**文件：** 临时 `scripts/verify-team.mts`（跑完删）  
**依赖：** T1–T11  
**步骤：**
1. 覆盖：建组、邮件并发、任务 CRUD、审批状态、merge 回滚、coord 双锁、工具过滤
2. inprocess spawn 最小空闲路径（可用桩循环代替真模型）

**验证：** 脚本输出 ALL OK 后删除

## 执行顺序

```
T1 → T2 → T3 → T4 ────────┐
T5（可并行）───────────────┤
T6（可并行）→ T7 → T8 → T9 → T10 → T11 → T12
```
