# SWE-bench-Live MultiLang 选题 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `scripts/select-swe-multilang-20.py` | 选题脚本 |
| 新建 | `scripts/requirements-swe-select.txt` | `datasets` 依赖 |
| 新建 | `tests/eval/swe-multilang/README.md` | 使用说明 |
| 新建 | `tests/eval/swe-multilang/selected-20.json` | 运行脚本生成 |
| 新建 | `tests/eval/swe-multilang/selected-20-ids.txt` | 运行脚本生成 |
| 新建 | `docs/17-swe-multilang-select/task.md` | 本文档 |
| 新建 | `docs/17-swe-multilang-select/checklist.md` | 下一阶段 |

---

## T1: 依赖说明文件

**文件：** `scripts/requirements-swe-select.txt`  
**依赖：** 无  
**步骤：**
1. 写入一行：`datasets>=2.14.0`

**验证：** 文件存在且含 `datasets`。

---

## T2: 实现选题脚本

**文件：** `scripts/select-swe-multilang-20.py`  
**依赖：** T1  
**步骤：**
1. 定义 `QUOTA` / `SPLITS` / `DEFAULT_SEED=42`（与 plan 一致）。
2. 实现 CLI：`--seed`、`--gold`、`--out-dir`（默认相对仓库根的 `tests/eval/swe-multilang`）。
3. 实现 `load_gold_ids`（jsonl + 纯文本）。
4. 按 SPLITS 顺序加载 HF split；只取所需字段。
5. 抽样：gold 过滤 → `Random(seed).shuffle` → repo 去重至配额；不足则 `sys.exit(1)`。
6. 全部凑齐后写 `selected-20.json` 与 `selected-20-ids.txt`；打印每 split 计数摘要。
7. 脚本顶部注明：需 Python 3.10+。

**验证：** `python scripts/select-swe-multilang-20.py --help`（或无参运行）在已装 `datasets` 且网络可用时成功；`count==20` 且配额正确。

---

## T3: README

**文件：** `tests/eval/swe-multilang/README.md`  
**依赖：** T2  
**步骤：**
1. 说明与 Track A 并存。
2. 安装：`pip install -r scripts/requirements-swe-select.txt`。
3. 运行命令、`--gold` 用法、配额表、输出文件含义、正式评测前建议 gold。
4. 注明输出不含 patch / problem_statement 全文。

**验证：** 文档含上述要点。

---

## T4: 生成冻结清单并自检

**文件：** `tests/eval/swe-multilang/selected-20.json`、`selected-20-ids.txt`  
**依赖：** T2、T3  
**步骤：**
1. 在仓库根执行：`python scripts/select-swe-multilang-20.py`（无 gold）。
2. 再跑一次相同 seed，对比 ids 集合一致。
3. 检查同 split 无重复 repo；JSON 无 patch/test_patch/problem_statement。
4. 将生成的清单纳入仓库（冻结）。

**验证：** 对照 checklist；网络/Python 不可用时记录阻塞并仅提交脚本+README，清单留待用户本机生成——**优先尝试生成**。

---

## 执行顺序

```
T1 → T2 → T3 → T4
```

---

## 自检

1. plan 模块 A–F 均有覆盖。
2. 配额与 seed 约定写死。
3. 依赖无环；每任务有验证。
