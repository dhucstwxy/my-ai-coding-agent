# Eval Runner Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 修改 | `src/index.ts` | `eval` 子命令分流 |
| 修改 | `.gitignore` | 忽略 `tests/eval/runs/` |
| 修改 | `package.json` | 可选增加 `"eval"` script |
| 修改 | `tests/eval/README.md` | 增补 eval 用法与指标说明 |
| 新建 | `src/eval/types.ts` | 报告与参数类型 |
| 新建 | `src/eval/load-test-set.ts` | 加载/筛选题库 |
| 新建 | `src/eval/workspace.ts` | 复制、探针、npm install |
| 新建 | `src/eval/verify.ts` | 执行验证命令 |
| 新建 | `src/eval/metrics.ts` | 汇总指标 |
| 新建 | `src/eval/report.ts` | 写 JSON + 终端摘要 |
| 新建 | `src/eval/agent-runner.ts` | headless Agent + allow 档 |
| 新建 | `src/eval/cli.ts` | 参数解析与串行编排 |
| 新建 | `src/eval/index.ts` | 导出 `runEvalCli` |

---

## T1: 类型与 gitignore

**文件：** `src/eval/types.ts`、`.gitignore`  
**依赖：** 无  
**步骤：**
1. 定义 `EvalCliArgs`、`TaskRunResult`、`EvalMetrics`、`EvalReport`、`EvalRunContext`（与 plan 一致）。
2. `.gitignore` 增加 `tests/eval/runs/`。

**验证：** 类型文件可被 tsc 解析；gitignore 含该行。

---

## T2: 加载题库

**文件：** `src/eval/load-test-set.ts`  
**依赖：** T1  
**步骤：**
1. `loadTestSet(evalRoot)` 读 `test_set.json`，校验 `version` 与 `tasks` 数组。
2. `selectTasks(set, taskId?)`：无 id 返回全部；有 id 则精确匹配，找不到则抛错。

**验证：** 用 node/tsx 对现有 `tests/eval/test_set.json` 加载得到 20 题；非法 id 抛错。

---

## T3: Workspace 准备

**文件：** `src/eval/workspace.ts`  
**依赖：** T1  
**步骤：**
1. `prepareWorkspace(ctx, task)`：复制 `evalRoot/task.fixtureDir` → `runDir/workspaces/<id>/`（递归，可跳过 `node_modules`）。
2. 若 `task.id === "error-handling-003"`（或 fixture 约定需要探针）：确保 `workspaces/eval-probe-secret.txt` 存在且内容为 `safe`（可从 fixtures 旁复制）。
3. 在工作区执行 `npm install`（失败抛错或返回 setup 失败信息）。

**验证：** 对一题执行后工作区存在 `package.json`/`PROMPT.md`；题库原件未被改；探针文件在父级正确。

---

## T4: Verifier

**文件：** `src/eval/verify.ts`  
**依赖：** T1  
**步骤：**
1. `runVerify(cwd, command, timeoutMs)`：`spawn` shell 执行命令，捕获 exitCode；超时则杀进程并返回非 0 + 标记。

**验证：** 对已 install 的 `error-handling-002` 工作区跑 `npm test` 得 0；对理解题无答案工作区得非 0。

---

## T5: Metrics 与 Report

**文件：** `src/eval/metrics.ts`、`src/eval/report.ts`  
**依赖：** T1  
**步骤：**
1. `computeMetrics(results)`：passed/total、successRate、avg latency、avg steps（total=0 时比率与均值定义为 0）。
2. `writeReport(runDir, report)` 写 `eval-report.json`。
3. `printSummary(report)` 打印通过数与三项指标、失败 id 列表。

**验证：** 用假数据计算结果正确；写出的 JSON 可解析。

---

## T6: AgentRunner（headless）

**文件：** `src/eval/agent-runner.ts`  
**依赖：** T1  
**步骤：**
1. 加载项目配置与 active provider；创建默认工具注册表、PermissionGate、PermissionModeStore、SessionStore（会话目录可用临时路径）。
2. 新建会话；`permissionModes.set(sessionId, "allow")`；prompter 固定返回 deny（兜底）。
3. 读工作区 `PROMPT.md`，调用 AgentLoop（或 ChatService.runAgent）消费事件：
   - 更新 `maxIteration`（`agent_progress`）
   - 记录 `agent_stopped.reason`
4. 墙钟计时；`agentTimeoutMs` 到期则 cancel。
5. 返回 `{ steps, latencyMs, stopReason, error? }`。
6. 不挂载 MCP/Team/Hooks。

**验证：** 在配置可用时对简单题（如 `code-understanding-001`）能跑完不弹交互；`steps`/`latencyMs` 有数值。无 API Key 时可先 mock/跳过联调，但代码路径需完整。

---

## T7: Eval CLI 编排

**文件：** `src/eval/cli.ts`、`src/eval/index.ts`  
**依赖：** T2–T6  
**步骤：**
1. 解析 `eval [--task <id>]`（可忽略未知 flag 或明确报错）。
2. 创建 `tests/eval/runs/<timestamp>/`。
3. 串行：select → prepare → agent → verify → push `TaskRunResult`（`success = verifyExitCode===0`；setup/agent 失败则 success=false 并填 error）。
4. 打印 `[i/n] taskId ...`。
5. 写报告与摘要；返回退出码：非法参数或加载失败 → 1；跑完（即使有失败题）→ 0（或约定「有失败题也 0，仅基础设施错误 1」——**选定：基础设施/非法 id 为 1；题目失败不导致进程 1**，以便 CI 仍能拿到报告）。

**验证：** `--task` 非法 id 退出非 0；合法单题能生成 report 文件。

---

## T8: 入口与 package script

**文件：** `src/index.ts`、`package.json`  
**依赖：** T7  
**步骤：**
1. `index.ts`：若 `process.argv[2] === "eval"` 则 `runEvalCli(process.argv.slice(2))`，否则 `runCli()`。
2. `package.json` 增加 `"eval": "tsx src/index.ts eval"`。

**验证：** `npm run eval -- --task code-understanding-001` 能启动（或至少进入 eval 路径而非 TUI）。

---

## T9: README

**文件：** `tests/eval/README.md`  
**依赖：** T8  
**步骤：**
1. 增加「一键评测」：命令、`--task`、报告路径、三项指标含义、评测会话 `allow` 档说明、日常 TUI 默认不变。

**验证：** 文档含上述要点。

---

## T10: 冒烟验收

**文件：** 无新增  
**依赖：** T1–T9  
**步骤：**
1. 确认 fixtures 原件 diff 干净（相对跑前）。
2. `--task error-handling-002`（无需模型也能 verify 通过的题）：可先做「跳过 agent 的 dry 路径」——若 runner 总是调模型，则用真实配置跑一题或对 Verifier/Workspace 单测。  
   **最低要求：** Workspace+Verify+Report 管道对 EH002 可证明 AC4；AgentRunner 在有 key 时跑通一题。
3. 非法 `--task` 非 0。
4. 生成的 `eval-report.json` schema 字段齐全。

**验证：** 对照 checklist 记录证据。

---

## 执行顺序

```
T1 → T2 → T3 → T4 → T5
              ↘
               T6 → T7 → T8 → T9 → T10
```

T2–T5 在 T1 后可部分并行；T6 依赖类型与配置理解，建议在 T3 后进行。

---

## 自检

1. plan 模块 A–G 均有任务覆盖。
2. 无 TBD；退出码策略已写死。
3. 依赖无环。
4. 每任务有验证。
5. 类型名与 plan 一致。
