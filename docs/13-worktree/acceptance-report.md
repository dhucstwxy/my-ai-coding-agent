# Git Worktree 隔离 验收报告

## 通过（全部）

### 实现完整性
- [x] 创建合法隔离目录 — 证据：verify 脚本 create 后路径存在
- [x] 非法名拒绝 — 证据：`../x`、含 `..`、空格、超长均 `ok: false`
- [x] 快速恢复 — 证据：二次 create `created: false`
- [x] enter 不 chdir — 证据：`process.cwd()` 前后相同
- [x] 变更保护删除 — 证据：脏目录 remove 抛错；干净可删
- [x] 环境初始化 — 证据：config 副本与 node_modules 软链存在
- [x] isolation 解析 — 证据：合法角色带 `worktree`；非法跳过有警告
- [x] 子循环换根 — 证据：`run.ts` 使用 `childRoot`
- [x] 系统生成 name — 证据：`generateAgentWorktreeName`
- [x] 结束清理 — 证据：`releaseWorktree`；失败只 log
- [x] janitor 三层过滤 — 证据：过期干净删除；活跃保留

### 集成 / 编译
- [x] cli 装配 WorktreeService + janitor.stop
- [x] `npm run typecheck` 退出码 0
- [x] 临时验证脚本 ALL OK（已删除）
- [x] lint：N/A（无独立脚本）

### 端到端
- [x] 并行写同相对路径互不覆盖
- [x] 非法名 / 脏删 / 快速恢复
- [x] 干净删除与脏保留

## T11 缓存键审计

已审计 `src/tools`、`src/instructions`、`src/memory`、`src/prompt`：不存在以相对路径为键的文件内容缓存。隔离依赖各调用传入的绝对 `workspaceRoot`（子循环为 worktree 绝对路径）。无需改缓存实现。

## 说明

完整「真实模型 + 声明 isolation 的角色委派」端到端未在本机接模型跑通；核心 Worktree 生命周期、校验、变更保护、janitor 与 catalog/run 接入已由脚本与 typecheck 覆盖。若需 tmux 对话验收，可另开一轮。
