# 任务

实现 `src/pipeline.ts` 的 `run()`：

1. 读取 `data/users.csv`（首行为表头 `id,name,email`）
2. 校验：三列都非空，且 email 含 `@`
3. 合法行写入 `out/users.json`（对象数组）
4. 返回 `{ written: number, skipped: number }`

不要修改测试文件。
