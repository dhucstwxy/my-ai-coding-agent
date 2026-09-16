# MewCode 结构化系统提示 验收报告

> 日期：2026-09-16  
> 默认联调：DeepSeek `deepseek-v4-flash`

## 通过

- [x] AC1 模块顺序与空槽 — 证据：`SECTION_IDS` 含 identity…memory；空槽 content 为空
- [x] AC2 stable 字节稳定、环境不进 stable — 证据：`STABLE_EQ true`，`STABLE_NO_WS true`，`FULL_HAS_WS true`
- [x] AC3 关键字 — 证据：MewCode / 计划模式 / 先读 / 专用工具 / system-reminder 均在 stable
- [x] AC4 环境走 reminder — 证据：执行模式 reminder 含 environment；stable 无工作区路径
- [x] AC5 工具描述强化 — 证据：`TOOL_HINTS true`
- [x] AC6/AC7 reminder 标签且不落盘 — 证据：冒烟 `NO_REMINDER_IN_STORE true`；模型自称 MewCode
- [x] AC8 计划控频 — 证据：R1=`plan_full+environment`，R3=`plan_brief+environment`，R6=`plan_reinforce+environment`
- [x] AC9 DeepSeek 缓存字段 — 证据：第 1 轮 `hit:0,miss:1615`；第 2 轮 `hit:1408,miss:261`，`available:true`
- [x] AC11 有字段时不伪造 — 证据：真实 API 返回数值
- [x] AC12 eval-scenarios.md — 证据：3 个场景文档已写
- [x] typecheck — 证据：`npm run typecheck` 退出码 0
- [x] collector cache — 证据：`COLLECTOR true`

## 跳过 / 待人工

- [ ] AC10 Anthropic — 配置无密钥，未实测（代码已打 `cache_control`）
- [ ] AC13/AC14 TUI 多步与拼装失败路径 — 建议本机 `npm start` 补一眼；Esc/`/plan` 逻辑未改编排核心
- [ ] 场景 2–4 人工定性 — 见 `eval-scenarios.md`

## 交付摘要

新增 `src/prompt/`（拼装 + reminder）；AgentLoop 每轮注入稳定 system 与临时 reminder；双协议解析/上报 cache；工具 description 双重强化；TUI 展示缓存行。
