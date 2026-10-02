# SWE-bench-Live MultiLang 选题 Plan

## 架构概览

本交付是离线选题工具，不接入 MewCode 运行时。

```
scripts/select-swe-multilang-20.py
        │
        ├─ load HF MultiLang (8 splits)
        ├─ optional: load gold instance_id set
        ├─ per-split: filter → shuffle(seed) → repo-dedupe → take quota
        └─ write tests/eval/swe-multilang/
              selected-20.json
              selected-20-ids.txt
              README.md
```

| 组件 | 职责 |
|------|------|
| CLI 参数 | `--seed`、`--gold`、`--out-dir` |
| Dataset loader | `datasets.load_dataset("SWE-bench-Live/MultiLang", split=...)` |
| Sampler | 配额 + 同仓去重 + 可复现 shuffle |
| Writer | JSON 清单 + ids.txt |
| README | 使用说明 |

与 Track A（本地 Vitest 20 题）并列，互不调用。

## 核心数据结构

### 配额常量

```python
QUOTA = {
  "ts": 4, "js": 3, "java": 3,
  "go": 2, "rust": 2, "cpp": 2, "c": 2, "cs": 2,
}  # sum == 20
SPLITS = list(QUOTA.keys())
DEFAULT_SEED = 42
```

### SelectedItem

```python
{
  "instance_id": str,
  "split": str,
  "repo": str,
  "docker_image": str | None,
  "created_at": str | None,
}
```

### SelectedSet

```python
{
  "version": 1,
  "dataset": "SWE-bench-Live/MultiLang",
  "seed": int,
  "goldFiltered": bool,
  "goldSource": str | None,
  "quota": { ... },
  "generatedAt": str,
  "count": 20,
  "items": [SelectedItem, ...]
}
```

### Gold 列表输入

1. JSONL：每行含 `instance_id`
2. 纯文本：每行一个 `instance_id`（忽略空行与 `#` 注释）

## 模块设计

### 模块 A：CLI

解析 `--seed`（默认 42）、`--gold PATH`（可选）、`--out-dir`（默认 `tests/eval/swe-multilang`）。

### 模块 B：Gold 加载

`load_gold_ids(path) -> set[str]`。

### 模块 C：数据集加载

按 split 加载；只取 `instance_id, repo, docker_image, created_at`。

### 模块 D：抽样器

Gold 过滤 → `Random(seed).shuffle` → repo 去重取配额；不足则非 0 退出。

### 模块 E：写出

`selected-20.json`、`selected-20-ids.txt`。

### 模块 F：README

静态中文说明。

## 模块交互

```
main
 → parse_args
 → load_gold_ids?
 → for split in SPLITS:
      load → filter → shuffle → sample
 → assert count==20
 → write outputs
 → print summary
```

Seed 约定：单个 `random.Random(seed)`，按 `SPLITS` 固定顺序依次抽样。凑齐前不落盘。

## 文件组织

```
scripts/select-swe-multilang-20.py
scripts/requirements-swe-select.txt   # datasets
tests/eval/swe-multilang/README.md
tests/eval/swe-multilang/selected-20.json      # 脚本生成
tests/eval/swe-multilang/selected-20-ids.txt
docs/17-swe-multilang-select/{spec,plan,task,checklist}.md
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 实现语言 | Python + datasets | HF 官方路径最短 |
| 配额 | ts4/js3/java3/其余各2 | 贴近 MewCode 又覆盖 8 语 |
| 可复现 | 单 RNG + 固定 SPLITS 顺序 | 简单稳定 |
| 同仓策略 | 每 split 内 repo 最多 1 | 多样性 |
| 不足配额 | 硬失败 | 避免静默少题 |
| Gold | 可选 | 本机能先出清单 |
| 输出内容 | 仅元数据 | 防泄题、控体积 |
| 与 Track A | 旁路目录 | 双轨清晰 |

## Spec 覆盖

| Spec | 归属 |
|------|------|
| F1 | 模块 C |
| F2 | A + D |
| F3 | D |
| F4 | B + D |
| F5–F6 | E |
| F7 | F |
| F8 | 文件组织边界 |
| N1–N5 | 抽样约定 + README + 输出裁剪 |
