# 记忆与会话 验收报告

验收日期：2026-09-25  
依据：`docs/08-memory/checklist.md`

## 通过（脚本 / typecheck）

- [x] 三层 AGENTS.md 顺序与缺层容错 — 证据：临时三层加载断言 ROOT < PROJ < USER
- [x] @include 合法展开 / 环路 / 越界跳过 — 证据：tsx 用例 warnings
- [x] 会话 JSONL 创建/追加/列表/替换 — 证据：SessionStore 临时目录用例；ID 匹配 YYYYMMDD-HHMMSS-xxxx
- [x] 坏行跳过与未配对 tool 截断 — 证据：readSessionFile + truncateUnpairedTools
- [x] 30 天清理 — 证据：旧 mtime 文件被 cleanup 删除
- [x] 时间 gap 24h 边界 — 证据：23h false / 25h true
- [x] 记忆索引截断与异步更新 — 证据：假 Provider 写出 INDEX 与 notes；失败 schedule 静默
- [x] `.gitignore` 含 `.mewcode/sessions/`
- [x] `npm run typecheck` 退出码 0

## 集成（代码已接入）

- [x] cli 使用 `projectSessionsDir`、启动 cleanup、预载 instructions/memory 并入 warnings
- [x] AgentLoop 将自定义指令与记忆拼入 request system；自然完成后 `scheduleMemoryUpdate`
- [x] tool-results 路径随项目 sessions 目录

## 端到端（需本机真实对话）

- [ ] 场景 1–5：建议在项目内写入 AGENTS.md 后 `npm start` 手动点验列表/恢复/记忆落盘

## 结论

可自动化条目已通过。真实模型下的端到端场景待本机手动验收。
