# SWE-bench-Live MultiLang 选题 Spec

## 背景

已有本地 Vitest 基础评测集（20 题）与 `npm run eval`。希望并行引入 SWE-bench-Live MultiLang，按 8 种语言配额凑满 20 题，作为 SWE 轨道的冻结候选集。

本轮只交付选题脚本与清单，不实现 Docker 内跑 Agent，也不封装官方 evaluation 全流程。

## 目标

- 提供 Python 选题脚本，从 `SWE-bench-Live/MultiLang` 按固定配额抽样。
- 配额：`ts=4, js=3, java=3, go=2, rust=2, cpp=2, c=2, cs=2`（合计 20）。
- 支持可选 gold 通过列表过滤；无列表时仍可抽样并标记未做 gold 过滤。
- 输出冻结清单与 ID 文本、使用说明 README。
- 与本地 Track A（`tests/eval` 20 题）并存，不互相替换。

## 功能需求

- F1: 拉取数据集。脚本从 Hugging Face 加载 `SWE-bench-Live/MultiLang` 的 8 个 split：`c`、`cpp`、`cs`、`java`、`go`、`rust`、`js`、`ts`。
- F2: 固定配额抽样。按上述配额抽取合计 20 题。默认随机种子固定（如 42），可通过参数覆盖。
- F3: 同仓去重。同一 split 内同一 `repo` 最多入选 1 题；若候选不足配额，报错并以非 0 退出。
- F4: 可选 Gold 过滤。若提供含 `instance_id` 的 gold 通过列表，先求交再抽样；未提供则使用全量 split，并标记 `goldFiltered: false`。
- F5: 输出冻结清单。写入 `tests/eval/swe-multilang/selected-20.json`，含生成元数据与每题 `instance_id`、`split`、`repo`、`docker_image`（若可得）、`created_at`（若可得）。
- F6: 输出 ID 列表。写入 `selected-20-ids.txt`（每行一个 `instance_id`）。
- F7: 使用说明。提供 README：安装依赖、运行方式、配额、gold 用法、与 Track A 关系、正式评测前建议 gold 验证。
- F8: 不破坏既有评测。不修改本地 20 题 fixture 语义；不改动 `npm run eval` 默认行为。

## 非功能需求

- N1: 可复现。相同 seed、相同 gold 输入、相同数据集条件下，输出的 20 个 `instance_id` 集合一致。
- N2: 依赖明确。Python 3.10+ 与 `datasets`；不强制改动 Node 项目依赖。
- N3: 网络。首次运行需能访问 Hugging Face；失败时给出可读错误。
- N4: 清单体积。输出 JSON 不包含 `patch` / `test_patch` / 完整 `problem_statement`。
- N5: 文档语言。README 使用中文。

## 不做的事

- 不实现 MewCode 在 Docker 内解题或导出 patch。
- 不封装或改写官方 evaluation 全流程。
- 不自动拉取 Docker 镜像、不跑 gold 评测本身（仅可选消费已有 gold 列表）。
- 不把 SWE 题并入现有 Vitest fixture 或 `npm run eval`。
- 不在仓库中提交完整 `problem_statement`、`patch`、`test_patch`。
- 不保证跨机器 Docker 可跑性。
- 不提交虚构的 SWE 跑分结果。

## 验收标准

- AC1: 默认 seed 运行脚本生成恰好 20 题，且各 split 数量符合配额。（F1、F2）
- AC2: 相同 seed、无 gold 时连续两次 `instance_id` 集合相同。（F2、N1）
- AC3: 同一 split 内无重复 `repo`；候选不足时非 0 退出并有明确错误。（F3）
- AC4: 有 gold 列表时入选 id 均在列表内且 `goldFiltered: true`；无 gold 时 `goldFiltered: false` 仍可出满 20 题（网络可用时）。（F4）
- AC5: 存在 `selected-20.json` 与 `selected-20-ids.txt`；JSON 无 patch/test_patch/完整 problem_statement。（F5、F6、N4）
- AC6: README 覆盖安装、运行、配额、gold、与 Track A 关系。（F7）
- AC7: 本地 fixture 与 `npm run eval` 未被本功能无关改动。（F8）
