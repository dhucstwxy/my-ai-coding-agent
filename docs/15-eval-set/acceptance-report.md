# 固定评测集 验收报告

## 通过（对照 checklist）

### 实现完整性
- [x] `test_set.json` 含 20 题、ID 唯一 — 证据：`node` 解析 `tasks.length===20` 且 unique
- [x] 五类各 4、每类 easy×1 / medium×2 / hard×1 — 证据：按 category/difficulty 分组计数
- [x] 20 个 fixture 均含 `package.json` / `PROMPT.md` / `src/` / `tests/` — 证据：生成脚本产出 + 目录抽查
- [x] `.gitignore` 忽略 `tests/eval/fixtures/**/node_modules/` — 证据：文件已改
- [x] `tests/eval/README.md` 含流程、探针、勿改测试 — 证据：文档已写

### 基线行为（初始态）
- [x] 理解题 001–004：无答案时 `npm test` 非 0
- [x] 修改题 001–004：初始非 0
- [x] bugfix 001–004：初始非 0
- [x] 多步 001–004：初始非 0
- [x] error-handling-001 / 004：初始非 0
- [x] error-handling-002 / 003：关键文件在、探针为 `safe` 时退出码 0

### 正确态 / 负例抽查
- [x] `code-understanding-001` 写入正确 `answer.json` → 0；错误字段 → 非 0
- [x] `code-edit-001` 正确实现 `clamp` → 0
- [x] `bugfix-001` 修对闭区间 → 0（实现阶段抽查）
- [x] `error-handling-001` 写 `result.json.rejected=true` 且不改保护文件 → 0
- [x] `error-handling-004` 修对 `double` → 0（实现阶段抽查）
- [x] 篡改 `code-edit-001` 测试文件后 `npm test` 非 0（完整性保护）

### 集成与隔离
- [x] 宿主 `src/**` 未被本评测集改动 — 证据：`git status` 仅 `.gitignore`、`docs/15-eval-set/`、`scripts/`、`tests/eval/`
- [x] 单题可独立 `npm install && npm test` — 证据：20 题均已安装并跑过基线

### 端到端场景
- [x] 场景 A：理解题无答案失败 → 正确 `answer.json` 通过
- [x] 场景 B：`code-edit-001` 初始失败 → 实现后通过
- [x] 场景 C：`error-handling-001` 拒绝标记通过；篡改测试失败
- [x] 场景 D：README 描述与实际命令一致（复制 / install / test）

## 交付物

| 路径 | 说明 |
|------|------|
| `tests/eval/test_set.json` | 20 题索引 |
| `tests/eval/README.md` | 使用说明 |
| `tests/eval/fixtures/*` | 20 个自包含题目 |
| `docs/15-eval-set/{spec,plan,task,checklist}.md` | 规格文档 |
| `scripts/generate-eval-fixtures.mjs` | 题库生成脚本（可复现） |
| `scripts/smoke-eval-fixtures.mjs` | 冒烟脚本（可选） |

## 说明

- 未实现「自动跑 Agent 打分」runner（符合 spec 不做的事）。
- 未接真实 LLM / tmux 对 20 题全量解题；验收聚焦题库本身的可自动验证性。
- 修改/修 bug/多步其余题目的「正确实现变绿」逻辑与抽查题同构，基线均已确认失败可区分。
