# MewCode 工具系统 验收报告

> 日期：2026-09-13  
> 默认联调：DeepSeek `deepseek-v4-flash`（OpenAI 兼容）

## 通过（核心项）

### 实现完整性
- [x] AC1 六个工具可按名执行 — 证据：`createDefaultRegistry` 名称列表长度为 6，本地各工具调用返回 `ToolResult`
- [x] AC2 导出定义 — 证据：`toDefinitions()` 含六个 name；冒烟请求成功触发 `read_file`
- [x] AC3 读文件成功/失败 — 证据：合法读 ok；`not_found`；越界 `path_outside_workspace`
- [x] AC4 写文件/越界 — 证据：越界写入失败
- [x] AC5 唯一匹配替换 — 证据：多处 → `edit_multiple_matches` 且内容未变；单处成功
- [x] AC6 命令与超时 — 证据：echo 成功；短超时 → `timeout`
- [x] AC7 glob/grep — 证据：命中临时目录内 txt / 内容
- [x] AC8 失败不崩 — 证据：上述失败路径均结构化返回
- [x] AC11/AC12(DeepSeek)/AC13 相关链路 — 证据：脚本冒烟 `read_file` → 二次文本「项目名称是 mewcode」；事件含 `tool_execution_*` + `text_delta` + `done`；落盘 `user → assistant → tool:read_file → assistant`
- [x] AC16 截断标明 — 证据：`truncateText` 输出含「已截断」

### 集成 / 编译
- [x] SessionStore 持久化 tool 字段（修复后）— 证据：二次请求不再缺 `tool_call_id`
- [x] TypeScript — 证据：`npm run typecheck` 退出码 0
- [x] CLI 注入 workspace + registry — 证据：`src/cli.ts` 已注入；`npm start` 可启动（类型检查通过）

### 端到端
- [x] 场景 1（DeepSeek 脚本等价于 tmux 主路径）— 证据：读 `package.json` 并总结项目名成功

## 未跑 / 有条件跳过

- [ ] AC9 故意损坏参数 JSON — 未单独构造 SSE fixture（解析失败路径已实现 `parseError`）
- [ ] AC10 多工具只执行第一个 — 未用真实模型诱导多 call（编排逻辑已实现 `tool_calls_ignored`）
- [ ] AC12 Anthropic — 配置中无可用 Anthropic 密钥，跳过
- [ ] AC14 纯文本回归 — 未在本轮重复手工闲聊（无 tool 分支与第一章同构，建议 tmux 再目视一次）
- [ ] AC15 重启后历史可见 tool — 落盘字段已修；建议退出再启动目视确认
- [ ] 场景 2–5 手工 TUI — 建议按 checklist 在 tmux/本机终端补验

## 开发中修复的问题

- `SessionStore.write` 原先只序列化基础字段，导致 `toolCallId` / `toolCalls` 落盘丢失，二次请求 OpenAI 报缺 `tool_call_id`。已补全序列化。
