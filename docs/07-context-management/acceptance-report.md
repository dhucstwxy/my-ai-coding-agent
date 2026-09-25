# 上下文管理 验收报告

验收日期：2026-09-20  
依据：`docs/07-context-management/checklist.md`

## 通过（脚本 / typecheck 可证）

- [x] Token 近似估算 — 证据：`estimateChars("abcd")===1`；锚点增量累加断言通过
- [x] Micro 单条/合计落盘 — 证据：超大 tool 消息 content 含 spill 标记且文件可读；大结果优先替换
- [x] 切分保留策略 — 证据：`recent.length>=5`，拼接还原；切点 user 划入 recent
- [x] 摘要 Prompt / 提取 — 证据：含禁工具与五段标题；草稿被丢弃
- [x] AutoCompact — 证据：假 Provider 返回五段后组装摘要+边界+recent
- [x] 熔断 — 证据：连续 3 次失败后 `attempted:false, circuitOpen:true`
- [x] `context_window` 解析 — 证据：YAML `64000` → `contextWindow===64000`
- [x] SessionStore `replaceMessages` / `writeToolResult` — 证据：临时目录读写断言
- [x] `/compact` — 证据：不写入命令原文；产出 `compact_done` 与摘要消息
- [x] `npm run typecheck` — 退出码 0

## 集成（代码接入已完成，行为由上述单测覆盖）

- [x] AgentLoop 请求前跑 Pipeline — 证据：`src/agent/loop.ts` 在 `streamChat` 前调用 `pipeline.run`
- [x] usage 更新锚点 — 证据：`turn.usage.inputTokens` → `pipeline.noteUsage`
- [x] TUI compact 提示 — 证据：`chat-screen.tsx` 处理 `compact_*` 并展示黄字状态行
- [x] 熔断期间 Micro 仍可跑 — 证据：Pipeline 在熔断判断之前执行 micro

## 端到端（需本机真实对话 / tmux）

本机为 Windows，未跑 tmux 全流程。建议手动验收：

- [ ] 场景 1：大工具输出 → 预览+路径 + tool-results 文件
- [ ] 场景 2：缩小 `context_window` 堆历史 → 自动重量压缩
- [ ] 场景 3：`/compact 备注` → 界面提示与会话改写
- [ ] 场景 4：摘要连续失败 3 次 → 熔断提示 → `/compact` 恢复
- [ ] 场景 5：摘要失败时会话不变

## 结论

实现与 checklist 中可自动化条目已通过。真实模型下的端到端场景待本机手动点验。
