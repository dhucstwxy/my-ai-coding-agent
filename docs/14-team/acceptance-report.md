# Team Lead 与长期小组 验收报告

## 通过

- [x] 小组 create/resume/deactivate/disband — 证据：verify-team 脚本 T1–T2
- [x] 邮箱并发与过期锁 — 证据：T3
- [x] 共享任务 CRUD — 证据：T4
- [x] Coordinator 双锁与写工具过滤 — 证据：T5
- [x] 后端选择不静默降级 — 证据：T6
- [x] 审批闸门 — 证据：T7
- [x] inprocess spawn/idle/resume/stop + worktree merge — 证据：T8–T9
- [x] Lead 工具与子 Agent 排除 team_* — 证据：T10–T11
- [x] `npm run typecheck` 退出码 0
- [x] cli 注册 Lead 工具并注入 filterLeadTools / teamStatusText

## 说明

- 无 tmux 会话时后端为 `inprocess`；pane 路径在 `TMUX` 可用时启用，强制失败不降级。
- 队员 `runLoop` 未注入真模型循环时，spawn 后立即自然空闲（便于无模型验收）；正式对话可后续注入 AgentLoop。
- 未跑 tmux 真人对话端到端；文件系统与工具视图路径已覆盖。

## 使用摘要

1. 主对话调用 `team_create` 建组/恢复  
2. `team_spawn` 派队员（默认 worktree）  
3. `team_task_*` / `team_message` 协作  
4. 需审批：队员 plan → Lead `type=approve|reject`  
5. `team_merge` 合并成员分支  
6. Coordinator：配置 `teams.coordinatorAvailable: true` 且 `MEWCODE_COORDINATOR=1`
