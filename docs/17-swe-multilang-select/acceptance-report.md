# SWE MultiLang 选题 验收报告

## 通过

- [x] `scripts/select-swe-multilang-20.py` 已实现（配额、seed、gold 可选、repo 去重、输出 JSON/ids）
- [x] `scripts/requirements-swe-select.txt` 含 `datasets`
- [x] `tests/eval/swe-multilang/README.md` 说明 Track A/B、安装、运行、gold、配额
- [x] 未改动 Track A fixtures / `npm run eval` 默认行为（仅旁路新增目录）
- [x] 文档齐全：`docs/17-swe-multilang-select/{spec,plan,task,checklist}.md`

## 未通过 / 阻塞

- [ ] 生成 `selected-20.json` / `selected-20-ids.txt`  
  **原因：** 本机评测环境访问 `huggingface.co:443` 失败（`curl: (28) Could not connect`）；Docker 内加载数据集同样长时间无进展。  
  **修复：** 在可访问 HF 的机器上执行：
  ```bash
  pip install -r scripts/requirements-swe-select.txt
  python scripts/select-swe-multilang-20.py
  ```
  然后将生成的两个清单文件提交入库冻结。

## 使用提醒

正式 SWE 评测前建议加 `--gold <gold_patch_evaluated_instances.jsonl>` 再生成清单。
