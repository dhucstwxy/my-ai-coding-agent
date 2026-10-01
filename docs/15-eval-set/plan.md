# 固定评测集 Plan

## 架构概览

评测集是纯资产交付，不接入 MewCode 运行时。由三层组成：

### 索引层（`tests/eval/test_set.json`）

机器可读目录：列出全部 20 题的 ID、类别、难度、fixture 相对路径、`promptFile`、`verifyCommand`、`passCriteria` / `failCriteria`。评测执行方（人或后续脚本）只读此文件即可定位题目，不含标准答案。

### Fixture 层（`tests/eval/fixtures/<task-id>/`）

每题一个自包含 TypeScript 小项目，典型内容：

| 部分 | 作用 |
|------|------|
| `package.json` + `tsconfig.json` + Vitest 配置 | 独立安装与 `npm test` |
| `src/`（及必要时 `data/`） | 初始业务代码（含故意留空、bug 或待理解逻辑） |
| `tests/` | 行为断言；理解题校验 `answer.json`；行为约束题校验哈希/文件存在性/`result.json` |
| `PROMPT.md` | 给 Agent 的用户任务原文（中文，不泄露期望值） |

完整性哈希优先内嵌于该题测试文件常量；复杂题可用 `integrity.json`。

### 说明层（`tests/eval/README.md`）

人工操作手册：复制工作区、安装、验证、通过含义、禁止改测试。

### 与 spec 的对应

- F1/F11 → 索引 + README
- F2–F5、N1–N7 → 自包含 fixture + Vitest
- F6–F10 → 五类各 4 个 fixture
- F12 → 不改 `src/` 下 Agent 代码

数据流（评测时，非本轮实现 runner）：

```
复制 fixture → Agent 读 PROMPT.md 并改工作区 → 执行 verifyCommand → 退出码 0/非0
```

## 核心数据结构

### TestSet（`test_set.json` 根对象）

```ts
interface TestSet {
  version: 1;
  tasks: TestCase[];
}
```

### TestCase

```ts
interface TestCase {
  id: string;                    // 如 "code-understanding-001"
  category:
    | "code-understanding"
    | "code-edit"
    | "bugfix"
    | "multi-step"
    | "error-handling";
  difficulty: "easy" | "medium" | "hard";
  fixtureDir: string;            // 相对 tests/eval，如 "fixtures/code-understanding-001"
  promptFile: string;            // 相对 fixture 根，固定 "PROMPT.md"
  verifyCommand: string;         // 如 "npm test"
  passCriteria: string;          // 人读：何时算通过
  failCriteria: string;          // 人读：何时算失败
}
```

### 理解题答案 `answer.json`（Agent 写入，schema 因题而异）

| 题目 | 字段 |
|------|------|
| `code-understanding-001` | `exportName: string`, `defaultRate: number` |
| `code-understanding-002` | `callChain: string[]` |
| `code-understanding-003` | `modulePath: string`, `functionName: string` |
| `code-understanding-004` | `timeoutMs: number`, `sourceFile: string` |

### 行为约束拒绝标记 `result.json`

```ts
interface RejectResult {
  rejected: true;
  reason?: string; // 可选；默认不参与精确文案判分
}
```

- `error-handling-001`：实现与测试未改，且 `result.json.rejected === true`（推荐组合判定）。
- `error-handling-002` / `003`：以受保护文件未变 / 区外探针未变为主；`result.json` 可选。
- `error-handling-004`：测试哈希不变且业务测试通过。

### IntegrityManifest（可选文件；优先用测试内常量）

```ts
interface IntegrityManifest {
  algorithm: "sha256";
  files: Record<string, string>; // 相对路径 → hex digest
}
```

### Fixture `package.json` 约定

- `name`: `@mewcode-eval/<task-id>`
- `private`: true
- `type`: `"module"`
- `scripts.test`: `"vitest run"`
- `devDependencies`: `vitest`、`typescript`、必要类型包

## 模块设计

### 模块 A：评测索引

**职责：** 维护 `tests/eval/test_set.json`。  
**对外接口：** 静态 JSON。  
**依赖：** 无。  
**满足：** F1。

### 模块 B：Fixture 公共骨架

**职责：** 每题统一具备 `package.json`、`tsconfig.json`、`vitest.config.ts`、`PROMPT.md`、`src/`、`tests/`。  
**对外接口：** `npm install` → `npm test`。  
**依赖：** Vitest、TypeScript。  
**满足：** F2、F4、N2、N3、N7。

### 模块 C：代码理解 fixtures（×4）

**职责：** 只读业务代码；测试校验 `answer.json`。  
**对外接口：** Agent 写 `answer.json`；`npm test` 判分。  
**依赖：** 模块 B。  
**满足：** F6、N6。

### 模块 D：代码修改 fixtures（×4）

**职责：** 源码留空或缺能力；行为断言，必要时断言复用了某导出。  
**对外接口：** Agent 改 `src/**`。  
**依赖：** 模块 B、G。  
**满足：** F7、F5。

### 模块 E：Bug 修复 fixtures（×4）

**职责：** 含可复现 bug；正反例防止假通过。  
**对外接口：** Agent 改实现；`npm test`。  
**依赖：** 模块 B、G。  
**满足：** F8、N5。

### 模块 F：多步任务 fixtures（×4）

**职责：** 新建文件 + 接线/流水线；缺一步即失败。  
**对外接口：** Agent 多文件改动后 `npm test`。  
**依赖：** 模块 B、G。  
**满足：** F9。

### 模块 G：完整性与行为约束

**职责：**

1. 测试保护：`tests/**` 的 sha256 与预置值一致。
2. `error-handling-001`：实现与测试未改 + `result.json.rejected === true`。
3. `error-handling-002`：关键路径仍存在。
4. `error-handling-003`：工作区外探针未变（路径由 README 约定）。
5. `error-handling-004`：测试哈希不变且业务测试通过。

**对外接口：** 各题 `tests/` 内联辅助函数（不抽共享包，保持自包含）。  
**依赖：** Node `crypto`。  
**满足：** F5、F10。

### 模块 H：说明文档

**职责：** `tests/eval/README.md`。  
**对外接口：** 给人读。  
**依赖：** 模块 A 字段约定。  
**满足：** F11。

### 模块边界

- 不包含 Agent runner、打分聚合、CI workflow。
- 不修改宿主 `src/**`。
- fixture 之间不 import 彼此。

## 模块交互

### 实现者编写题库时（本轮交付）

```
实现者编写 fixture（src + tests + PROMPT）
    → 计算受保护文件哈希写入测试常量（或 integrity.json）
    → 登记 TestCase 到 test_set.json
    → 更新 README
```

说明：此处「实现者」指按 task.md 落地评测资产的开发者/编码代理，不是评测集的审批用户。用户负责审批文档与验收，无需手写 fixture 源码。

### 单题评测时（执行方操作；本轮不实现 runner）

```
1. 读 test_set.json，按 id 取 TestCase
2. 复制 fixtureDir → 独立工作区 W
3. 在 W 执行 npm install
4. Agent 以 W 为工作区，读取 PROMPT.md，读写 W 内文件
5. 在 W 执行 verifyCommand（npm test）
6. 退出码 0 → 通过；非 0 → 失败
```

### 题型数据流

| 类别 | Agent 主要写入 | 测试主要读取 |
|------|----------------|--------------|
| 理解 | `answer.json` | 答案文件 + 固定期望 |
| 修改/修 bug/多步 | `src/**`（及新建文件） | 导入源码行为；完整性哈希 |
| 行为约束 | 少写或不写；或 `result.json` | 哈希、文件存在性、区外探针、`result.json` |

### 完整性交互

```
npm test 启动
  → 先断言 tests/** 哈希匹配
  → 再跑行为/答案断言
哈希失败则整题失败
```

### 依赖方向（无环）

```
README ──读──► test_set.json
Agent/人 ──读──► PROMPT.md、src/
Agent ──写──► answer.json / src / result.json
Vitest ──读──► 上述产物 + 哈希基准
```

## 文件组织

```
tests/eval/
├── README.md
├── test_set.json
└── fixtures/
    ├── code-understanding-001/
    │   ├── package.json
    │   ├── tsconfig.json
    │   ├── vitest.config.ts
    │   ├── PROMPT.md
    │   ├── src/
    │   └── tests/
    ├── code-understanding-002/
    ├── code-understanding-003/
    ├── code-understanding-004/
    ├── code-edit-001/
    ├── code-edit-002/
    ├── code-edit-003/
    ├── code-edit-004/
    ├── bugfix-001/
    ├── bugfix-002/
    ├── bugfix-003/
    ├── bugfix-004/
    ├── multi-step-001/
    ├── multi-step-002/
    ├── multi-step-003/
    ├── multi-step-004/
    ├── error-handling-001/
    ├── error-handling-002/
    ├── error-handling-003/
    └── error-handling-004/

docs/15-eval-set/
├── spec.md
├── plan.md
├── task.md
└── checklist.md
```

约定：

- fixture 目录名与任务 `id` 一致。
- 理解题不预置正确答案的 `answer.json`。
- 宿主 `package.json` / `src/**` 不为评测集改业务逻辑。
- `.gitignore` 忽略各 fixture 的 `node_modules`。

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 交付形态 | 纯静态题库，不做 Agent runner | 符合 spec「不做的事」；先保证可自动验题 |
| Fixture 形态 | 每题自包含 package + Vitest | 独立工作区可跑；隔离失败域 |
| 理解题判分 | `answer.json` + 精确字段断言 | 客观、可区分对错；不靠 LLM 自评 |
| 测试防刷 | sha256 完整性校验（测试内常量优先） | 满足 F5；改测试即失败 |
| 行为约束题 | 工作区状态断言 + 可选 `result.json` | 评的是 Agent 守规矩 |
| 区外写入题 | README 约定探针路径；测试读探针 | 可自动验未越界写 |
| 语言与提示 | PROMPT/README 中文；标识符英文 | 对齐 N8 |
| 依赖版本 | 各 fixture 固定 vitest/typescript，兼容 Node 20+ | 可重复、免宿主依赖 |
| 与宿主关系 | 不改 `src/**`；gitignore fixture `node_modules` | F12 |
| 出题方 | 实现阶段由实现者生成全部 fixture | 用户审批与验收，不手写题库 |

## Spec 覆盖自检

| Spec | 归属 |
|------|------|
| F1 | 模块 A |
| F2–F4 | 模块 B |
| F5 | 模块 G |
| F6 | 模块 C |
| F7 | 模块 D |
| F8 | 模块 E |
| F9 | 模块 F |
| F10 | 模块 G |
| F11 | 模块 H |
| F12 | 技术决策 / 文件组织 |
| N1–N8 | 骨架约定 + 技术决策 |
