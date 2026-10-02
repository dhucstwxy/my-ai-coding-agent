# SWE-bench-Live MultiLang 选题 Checklist

> 每一项通过运行或观察验证。

## 实现完整性

- [ ] 存在 `scripts/select-swe-multilang-20.py` 与 `scripts/requirements-swe-select.txt`
- [ ] 存在 `tests/eval/swe-multilang/README.md`
- [ ] 存在 `selected-20.json` 与 `selected-20-ids.txt`（或文档说明因环境未生成的原因）

## 抽样正确性

- [ ] `count == 20`，且 split 计数为 ts4 / js3 / java3 / go2 / rust2 / cpp2 / c2 / cs2（验证：解析 JSON）
- [ ] 相同 `--seed 42` 连续两次，`instance_id` 集合相同（验证：跑两遍 diff ids）
- [ ] 同一 split 内 `repo` 无重复（验证：脚本或手工分组）
- [ ] JSON 不含 `patch` / `test_patch` / `problem_statement` 字段（验证：读文件键名）

## Gold 模式

- [ ] 无 `--gold` 时 `goldFiltered === false` 且仍 20 题（验证：读 JSON）
- [ ] 提供裁剪后的 gold 文本（仅少量 id）时，入选 id 均属于该集合且 `goldFiltered === true`；或因不足配额非 0 退出并有明确错误（验证：构造小 gold 文件）

## 文档与隔离

- [ ] README 含安装、运行、配额、gold、与 Track A 关系
- [ ] `tests/eval/fixtures` 与 `src/eval` 无本功能导致的无关改动（验证：git status / diff）

## 端到端

- [ ] 场景：`pip install -r scripts/requirements-swe-select.txt` → `python scripts/select-swe-multilang-20.py` → 打开清单看到 20 题摘要

## Spec 对齐

| AC | 覆盖 |
|----|------|
| AC1–AC3 | 抽样正确性 |
| AC4 | Gold 模式 |
| AC5 | 实现完整性 + JSON 键约束 |
| AC6–AC7 | 文档与隔离 |
