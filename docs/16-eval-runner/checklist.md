# Eval Runner Checklist

> 每一项通过运行代码或观察行为来验证，聚焦系统行为。

## 实现完整性

- [ ] 存在 `src/eval/` 编排模块，可由 CLI 进入（验证：`npm run eval -- --help` 或非法参数有明确输出 / 源码入口分流存在）
- [ ] `EvalReport` / `TaskRunResult` / `EvalMetrics` 类型与报告字段齐全（验证：读 `types.ts` + 生成的 JSON）
- [ ] `.gitignore` 包含 `tests/eval/runs/`（验证：读文件）
- [ ] `tests/eval/README.md` 说明 eval 命令、报告路径、三项指标、allow 档（验证：读文档）

## CLI 与题库

- [ ] 非法 `--task` 退出码非 0 且有错误信息（验证：`npm run eval -- --task not-exist`）
- [ ] 合法 `--task <id>` 只跑一题，报告 `tasks.length === 1`（验证：跑单题后读 JSON）
- [ ] 无 `--task` 时任务列表为全量 20（验证：加载逻辑或干跑日志 / 报告 total）

## 隔离与探针

- [ ] 跑题后 `tests/eval/fixtures/` 原件无业务改动（验证：跑前后 hash/git status 对比 fixture）
- [ ] 工作区落在 `tests/eval/runs/<ts>/workspaces/<id>/`（验证：目录存在）
- [ ] `error-handling-003`：父级探针缺失时该题失败且 `error` 可辨；探针为 `safe` 时验证可执行（验证：构造缺失/存在两种情况）

## 权限与 Headless

- [ ] 评测过程中不出现需人工确认的权限提示（验证：跑需写文件的题，如 `code-edit-001`，过程无阻塞询问）
- [ ] 日常无参启动 TUI 的默认权限档仍非评测自动全放行（验证：读启动路径 / 默认 `PermissionMode` 仍为 default）

## 验证管道与指标

- [ ] 对未解题工作区执行 verify 得非 0；对正确产物（或 EH002 基线）得 0（验证：直接调 verify 或观察报告 success）
- [ ] 报告每题含 `success`、`latencyMs`、`steps`（验证：读 JSON）
- [ ] `metrics.taskSuccessRate === passed/total`；平均值与明细一致（验证：手算对照）
- [ ] 终端打印摘要：通过数、三项指标、失败 id（验证：观察 stdout）

## 超时与串行

- [ ] 单题 Agent/验证超时后该题失败且继续后续题（验证：将超时调极低跑两题，或代码路径单测）
- [ ] 全量/多题时进度按串行输出（验证：日志顺序 `[1/n]`…`[2/n]`）

## 编译与集成

- [ ] `npm run typecheck` 通过（或项目既有 typecheck 命令）
- [ ] 宿主日常 `runCli` 路径未被误改为必须 eval

## 端到端场景

- [ ] 场景 A：`npm run eval -- --task error-handling-002` → 生成 `eval-report.json`，字段完整（Agent 若因缺 key 失败，至少 Workspace+Verify 路径可用或报告含明确 error）
- [ ] 场景 B：`--task code-understanding-001`（有有效模型配置时）→ 不交互跑完 → 报告含 latency/steps；成功与否以 npm test 为准
- [ ] 场景 C：仅按 README 完成「安装依赖 → 跑单题 eval → 打开报告」闭环

## Spec 对齐速查

| AC | Checklist 覆盖 |
|----|----------------|
| AC1 | CLI 与题库 |
| AC2 | 隔离与探针（原件） |
| AC3 | 权限与 Headless |
| AC4 | 验证管道 |
| AC5–AC6 | 指标与报告 |
| AC7 | 串行 |
| AC8 | 探针 |
| AC9 | 超时 + 日常权限 |
| AC10 | README |
