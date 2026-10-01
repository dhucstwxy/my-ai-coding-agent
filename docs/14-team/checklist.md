# Team Lead 与长期小组 Checklist

> 每一项通过运行代码或观察行为来验证，聚焦系统行为。

## 实现完整性

- [x] 按合法名创建小组后用户目录出现持久化根，含花名册与负责人；同名恢复不清空任务与邮箱（验证：临时 HOME 下 create/resume）
- [x] 同时只有一个活跃小组；切换前须停用当前（验证：第二次 create 被拒绝）
- [x] 解散删除该小组文件夹且无活跃（验证：disband 后路径不存在）
- [x] 后端选择与不静默降级（验证：select；forcePaneUnavailable 文案含 pane/不会降级）
- [x] 默认队员写独立 worktree（验证：runner.spawn + merge 路径使用 worktree）
- [x] 自然停下后空闲且 Lead 收到 idle 邮件；resume 不增花名册行（验证：verify 脚本）
- [x] Lead 终止成员后 status=stopped，条目仍在（验证：runner.stop）
- [x] 共享任务 CRUD + 依赖字段；子 Agent 工具列表无 team_*（验证：tasks + visibleTools）
- [x] Lead 具备 team_merge 等；agent 仍在 registry（验证：createLeadTeamTools + cli 注册）
- [x] 审批闸门 approve/reject（验证：assertWritable / applyApprovalMail）
- [x] 消息字段与广播（验证：mailbox send/broadcast）
- [x] 并发写邮箱与过期锁（验证：并行 send + 陈旧 lock）
- [x] 合并无冲突成功（验证：mergeMemberBranches）
- [x] Coordinator 双锁与写工具过滤（验证：isCoordinatorActive + filterBaseToolsForLead）

## 集成

- [x] cli 装配 TeamStore、注册 Lead 工具、prompt 过滤与 teamStatusText（验证：cli.ts + typecheck）
- [x] 普通 agent 子 Agent 排除 team_*（验证：visibleTools）
- [x] 环境提醒含小组与 Coordinator（验证：reminder teamStatus + cli teamStatusText）
- [x] 唤醒失败不丢信（验证：wake 返回值与「已写入」文案路径存在于 team_message）

## 编译与测试

- [x] `npm run typecheck` 退出码 0
- [x] 临时验证脚本 ALL OK（已删除）
- [x] lint：N/A

## 端到端场景

- [x] 场景 1：建组 → spawn worktree 队员 → 任务 → idle 邮件 → merge 无冲突
- [x] 场景 2：审批拒绝/批准状态机
- [x] 场景 3：Coordinator 双锁与工具过滤；子 Agent 无 team_*

## Spec 对照

| Spec | Checklist |
|------|-----------|
| AC1–AC15 | 上列各项（脚本 + typecheck + 代码接入） |
