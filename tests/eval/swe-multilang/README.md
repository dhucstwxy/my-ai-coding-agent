# SWE-bench-Live MultiLang 选题清单（Track B）

与本地 Vitest 基础评测集（Track A，`tests/eval` + `npm run eval`）**并存**，不互相替换。

本目录存放从 [SWE-bench-Live/MultiLang](https://huggingface.co/datasets/SWE-bench-Live/MultiLang) 按固定配额抽出的 **20** 道题 ID，供后续 Docker + 官方 evaluation 使用。

## 配额

| split | 语言 | 题数 |
|-------|------|------|
| ts | TypeScript | 4 |
| js | JavaScript | 3 |
| java | Java | 3 |
| go | Go | 2 |
| rust | Rust | 2 |
| cpp | C++ | 2 |
| c | C | 2 |
| cs | C# | 2 |
| **合计** | | **20** |

同一 split 内同一 `repo` 最多 1 题。默认随机种子 `42`。

## 安装

需要 Python 3.10+：

```bash
pip install -r scripts/requirements-swe-select.txt
```

## 生成 / 刷新清单

在仓库根目录：

```bash
# 无 gold 过滤（清单中 goldFiltered=false）
python scripts/select-swe-multilang-20.py

# 指定 seed / 输出目录
python scripts/select-swe-multilang-20.py --seed 42 --out-dir tests/eval/swe-multilang

# 仅在本机 gold 通过的 instance 中抽样
python scripts/select-swe-multilang-20.py --gold path/to/gold_patch_evaluated_instances.jsonl
```

输出：

- `selected-20.json` — 元数据清单（**不含** `patch` / `test_patch` / 完整 `problem_statement`）
- `selected-20-ids.txt` — 每行一个 `instance_id`，便于传给官方 `--instance_ids`

## Gold 过滤说明

正式评测前，建议用官方脚本对目标 split 跑 gold patch，将通过列表传给 `--gold`，再重新生成清单（`goldFiltered=true`）。

无 gold 文件时仍可生成候选 ID，但跨机器可跑性不保证。

## 与 Track A 的关系

| 轨道 | 入口 | 用途 |
|------|------|------|
| A | `npm run eval` | 本地小仓库基础能力 |
| B | 本目录清单 + SWE-bench-Live evaluation | 真实多语言 SWE 任务 |

分数请分开报告，不要直接加总。

## 下一步（本目录不做）

- 在 Docker 沙箱中用 MewCode 解题并导出 patch
- 调用 `python -m evaluation.evaluation` 判分

请参阅 [microsoft/SWE-bench-Live](https://github.com/microsoft/SWE-bench-Live) 与 `docs/17-swe-multilang-select/`。
