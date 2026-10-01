# Git Worktree 隔离 Checklist

> 每一项通过运行代码或观察行为来验证，聚焦系统行为。

## 实现完整性

- [x] Worktree 服务可创建合法隔离目录（验证：临时 git 仓 create 后出现 `.mewcode/worktrees/<name>/`；主区分支未变）
- [x] 非法目录名被拒绝且无副作用（验证：`../x`、含 `..`、非法字符、超长均失败）
- [x] 已存在目录走快速恢复（验证：二次 create 返回 `created: false`）
- [x] enter/exit 不修改进程 cwd（验证：enter 前后 `process.cwd()` 相同）
- [x] 干净目录可删除，脏目录拒绝删除（验证：未提交文件时 remove 抛错；干净可删）
- [x] 环境初始化按固定规则生效（验证：config 副本与 `node_modules` 软链存在）
- [x] 角色 `isolation: worktree` 可被加载（验证：合法读入；非法值跳过并警告）
- [x] 隔离子 Agent 使用隔离根路径（验证：`run.ts` 将 `childRoot` 传入 `AgentLoop`；Fork/无 isolation 仍用主区）
- [x] 隔离 name 由系统生成且模型不可指定（验证：`generateAgentWorktreeName`；委派参数无 worktree name 字段）
- [x] 子 Agent 结束后按变更保留或删除（验证：`releaseWorktree` 在 blocked 时保留，否则 remove；失败只打日志）
- [x] 过期清理三层过滤（验证：缩短 ttl 后过期干净非活跃可删；活跃不删）

## 集成

- [x] `startSubAgent` 在 isolation 路径上调用 WorktreeService create/enter/exit/remove（验证：代码路径 + typecheck）
- [x] cli 启动 janitor，退出时 stop（验证：`cli.ts` 装配与 shutdown）
- [x] 子循环 `ToolContext.workspaceRoot` 为隔离绝对路径（验证：`AgentLoop` 使用 `childRoot`）
- [x] 路径相关逻辑按绝对根隔离（验证：主区与 worktree 同相对路径写入不同内容互不影响）

## 编译与测试

- [x] 项目 typecheck / 构建无错误（验证：`npm run typecheck` 退出码 0）
- [x] 本步相关自动化脚本或测试通过（验证：临时 `scripts/verify-worktree.mts` 输出 ALL OK 后已删除）
- [x] lint 检查通过（验证：仓库未配置独立 lint 脚本，记 N/A）

## 端到端场景

- [x] 场景 1：主区与隔离目录并行改同一相对路径 → 两侧内容互不覆盖（验证：verify 脚本 T11 parallel）
- [x] 场景 2：非法 name / 脏目录删除 / 快速恢复（验证：verify 脚本 T2 + T5）
- [x] 场景 3：结束后干净可删、有改动保留（验证：dirty remove blocked + clean remove；`releaseWorktree` 逻辑）

## Spec 对照

| Spec | Checklist |
|------|-----------|
| AC1 | 实现完整性 1 + 端到端 1 |
| AC2 | 实现完整性 2 + 端到端 2 |
| AC3 | 实现完整性 3 + 端到端 2 |
| AC4 | 实现完整性 4 |
| AC5 | 实现完整性 5 + 端到端 2 |
| AC6 | 实现完整性 6 |
| AC7 | 集成 4 + 端到端 1 |
| AC8 | 实现完整性 7、8 + 集成 1、3 |
| AC9 | 实现完整性 9 |
| AC10 | 实现完整性 10 + 端到端 3 |
| AC11 | 实现完整性 11 |
| AC12 | 编译与测试 + 端到端 1、2 |
