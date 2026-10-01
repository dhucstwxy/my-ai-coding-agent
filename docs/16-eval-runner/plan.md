# Eval Runner Plan

## 架构概览

Eval Runner 是独立于 TUI 的批处理编排层，复用现有配置加载、Provider、工具注册与 `AgentLoop`/`ChatService`，不经 Ink 界面。

```
index.ts
  ├─ 无参/默认 → runCli()（现有 TUI）
  └─ argv 含 eval → runEvalCli()（本模块）
         │
         ▼
┌─────────────────────────────────────────┐
│  src/eval/                              │
│  load-test-set → select tasks           │
│  workspace（复制 fixture + 探针 + npm i）│
│  agent-runner（headless + allow 档）    │
│  verify（执行 npm test / 超时）         │
│  metrics + report（写 eval-report.json）│
└─────────────────────────────────────────┘
```

| 组件 | 职责 |
|------|------|
| Eval CLI | 解析 `--task`、跑全量、进度日志、退出码 |
| TestSet 加载 | 读 `tests/eval/test_set.json` |
| Workspace | 复制到 `runs/<ts>/workspaces/<id>/`，装依赖，处理探针 |
| AgentRunner | 以工作区为 `workspaceRoot` 装配精简依赖；`permissionModes.set(session, "allow")`；喂 `PROMPT.md`；采集 `steps`/`latencyMs` |
| Verifier | 在工作区跑 `verifyCommand`，判成功/失败 |
| Reporter | 汇总三项指标，写 `eval-report.json` |

与 spec 对应：F1→CLI；F2–F3→加载/工作区；F4–F5→AgentRunner；F6→Verifier；F7–F9→度量与报告；F10 串行由 CLI 编排；F11 探针在 Workspace。

## 核心数据结构

### EvalCliArgs

```ts
interface EvalCliArgs {
  taskId?: string;
  agentTimeoutMs: number;  // 默认 300_000
  verifyTimeoutMs: number; // 默认 120_000
}
```

### TestCase

沿用 `tests/eval/test_set.json` 条目：`id`、`category`、`difficulty`、`fixtureDir`、`promptFile`、`verifyCommand` 等。

### TaskRunResult

```ts
interface TaskRunResult {
  taskId: string;
  category: string;
  difficulty: string;
  success: boolean;
  latencyMs: number;
  steps: number;
  workspacePath: string;
  error?: string;
  agentStopReason?: string;
  verifyExitCode?: number;
}
```

### EvalMetrics

```ts
interface EvalMetrics {
  taskSuccessRate: number;
  averageLatencyMs: number;
  averageSteps: number;
  passed: number;
  total: number;
}
```

### EvalReport

```ts
interface EvalReport {
  version: 1;
  createdAt: string;
  providerName?: string;
  model?: string;
  tasks: TaskRunResult[];
  metrics: EvalMetrics;
}
```

### EvalRunContext

```ts
interface EvalRunContext {
  repoRoot: string;
  runDir: string;
  evalRoot: string;
  args: EvalCliArgs;
}
```

### 计数约定

- **Steps**：监听 `agent_progress.iteration`，取最大值；首轮前失败则为 `0`。
- **Latency**：从调用 Agent 到结束事件/超时的墙钟毫秒；不含复制与 `npm install`。

## 模块设计

### 模块 A：Eval CLI

**职责：** 解析 argv；创建 `runDir`；串行调度；打印进度/摘要；退出码。  
**对外接口：** `runEvalCli(argv: string[]): Promise<number>`  
**依赖：** B–F。  
**满足：** F1、F9、F10、N5。

### 模块 B：TestSet 加载

**职责：** 读取并校验题库；按 id 过滤。  
**对外接口：** `loadTestSet(evalRoot)`；`selectTasks(set, taskId?)`  
**依赖：** 无。  
**满足：** F2。

### 模块 C：Workspace

**职责：** 复制 fixture；写/校验区外探针；`npm install`。  
**对外接口：** `prepareWorkspace(ctx, task)`  
**依赖：** Node fs / child_process。  
**满足：** F3、F11、N2、N4。

### 模块 D：AgentRunner

**职责：** 精简 Agent 栈；评测会话 `allow` 档；跑 `PROMPT.md`；采集 steps/latency；超时 cancel。  
**对外接口：** `runAgentOnTask(...)`  
**依赖：** `loadConfig`、`createProvider`、`createDefaultRegistry`、`PermissionGate`、`AgentLoop`/`ChatService`。  
**本轮不挂载：** MCP / Team / Subagent / Hooks。  
**满足：** F4、F5、F7、N3、N6。

### 模块 E：Verifier

**职责：** 执行 `verifyCommand`，带超时。  
**对外接口：** `runVerify(workspacePath, command, timeoutMs)`  
**满足：** F6、N3。

### 模块 F：Metrics + Report

**职责：** 汇总三项指标；写 JSON；终端摘要。  
**对外接口：** `computeMetrics`；`writeReport`；`printSummary`  
**满足：** F7、F8、F9。

### 模块 G：文档

**职责：** 更新 `tests/eval/README.md`。  
**满足：** N7。

### 边界

- `allow` 档不绕过危险命令黑名单与沙箱。
- 不修改题库断言语义。
- 日常无参启动仍走 TUI，默认权限档不变。

## 模块交互

### 主调用链（单题）

```
CLI
 → loadTestSet / selectTasks
 → prepareWorkspace（复制 + 探针 + npm install）
 → runAgentOnTask（allow 档 + PROMPT.md）
 → runVerify（npm test）
 → 组装 TaskRunResult（success = verifyExitCode===0）
 → 下一题…
 → computeMetrics → writeReport → printSummary
```

### 成功判定

```
success = setup 成功且 verifyExitCode === 0
```

Agent 的 `stopReason` 不单独决定成功；以验证命令为准。Agent 崩溃/超时记失败并写 `error`。

### 权限数据流

```
PermissionModeStore.set(sessionId, "allow")
 → PermissionGate：mode===allow → 直接 allow
 → 不问 prompter（黑名单/沙箱仍可 deny）
```

### 报告落盘

```
tests/eval/runs/<timestamp>/
  eval-report.json
  workspaces/<taskId>/
```

### 依赖方向（无环）

```
CLI → Load → Workspace → AgentRunner → Verifier → Metrics/Report
AgentRunner → config / provider / tools / permission / agent
```

## 文件组织

```
src/
├── index.ts                 — argv[2]==="eval" → runEvalCli，否则 runCli
├── eval/
│   ├── index.ts
│   ├── cli.ts
│   ├── types.ts
│   ├── load-test-set.ts
│   ├── workspace.ts
│   ├── agent-runner.ts
│   ├── verify.ts
│   ├── metrics.ts
│   └── report.ts
└── …

tests/eval/
├── README.md                — 增补 eval 用法
├── runs/                    — gitignore
└── …

docs/16-eval-runner/
├── spec.md
├── plan.md
├── task.md
└── checklist.md
```

`.gitignore` 增加：`tests/eval/runs/`  
`package.json` 可选：`"eval": "tsx src/index.ts eval"`

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 入口分流 | `index.ts` 识别 `eval` | 不污染 TUI 启动路径 |
| 权限 | 评测会话 `allow` 档 | 已有能力；日常默认不变 |
| Agent 装配 | 精简六工具 + AgentLoop | 缩小评测面 |
| 成功标准 | `verifyCommand` 退出码 | 与题库客观断言一致 |
| Steps | `agent_progress.iteration` 最大 | 主循环迭代轮数 |
| Latency | 仅 Agent 段墙钟 | 排除 install 噪声 |
| 执行次序 | 串行 | 简单、可控 |
| 工作区 | `runs/<ts>/workspaces/<id>` | 可复查 |
| 超时 | Agent / verify 分设默认 | 单题挂死不堵整批 |
| 本轮指标 | Success / Latency / Steps | 最小可跑通 |

## Spec 覆盖自检

| Spec | 归属 |
|------|------|
| F1 | 模块 A |
| F2 | 模块 B |
| F3、F11 | 模块 C |
| F4、F5 | 模块 D |
| F6 | 模块 E |
| F7–F9 | 模块 F + A |
| F10 | 模块 A |
| N1–N7 | 各模块约定 + 文档 |
