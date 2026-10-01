# Eval Runner 验收报告

## 通过（对照 checklist）

### 实现完整性
- [x] `src/eval/` 模块存在，`npm run eval` 可进入 — 证据：`--help` / `--task not-exist` 正常
- [x] 报告字段齐全 — 证据：真实跑题生成的 `eval-report.json`
- [x] `.gitignore` 含 `tests/eval/runs/`
- [x] README 增补一键评测、指标、allow 档说明

### CLI
- [x] 非法 `--task` 退出码 1 — 证据：`未知任务 ID：not-exist`，EXIT:1
- [x] 合法单题 `tasks.length===1` — 证据：EH002 报告
- [x] typecheck 通过 — 证据：`npm run typecheck` exit 0

### 端到端
- [x] `npm run eval -- --task error-handling-002` → PASS，steps=5，latencyMs≈6345，Success Rate 100%
- [x] 报告路径：`tests/eval/runs/<timestamp>/eval-report.json`
- [x] 模型信息写入报告（deepseek / deepseek-v4-flash）
- [x] 评测过程无权限交互阻塞（allow 档）
- [x] 日常 TUI 入口未改默认权限（`index.ts` 仅分流 eval；`cli.ts` 未改权限默认）

### 指标一致性
- [x] `taskSuccessRate === passed/total`（1/1=1）
- [x] averageLatencyMs / averageSteps 与单题一致

## 未在本机全量跑 20 题

全量串行依赖模型配额与时间；管道已由单题真实 Agent 跑通验证。可用：

```bash
npm run eval
```

按需补全量报告。

## 交付物

| 路径 | 说明 |
|------|------|
| `src/eval/**` | Runner 实现 |
| `src/index.ts` | eval 分流 |
| `docs/16-eval-runner/*` | spec/plan/task/checklist |
| `tests/eval/README.md` | 使用说明 |
