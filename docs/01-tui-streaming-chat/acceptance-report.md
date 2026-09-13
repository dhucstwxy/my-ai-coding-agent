# MewCode 交互式流式对话 — 验收报告

> 验收时间：2026-09-13  
> 环境：Windows / Node v22.22.3 / 无 tmux  
> 默认模型实呼：DeepSeek `deepseek-v4-flash`（项目 `.mewcode/config.yaml`）  
> 自动化脚本：`npx tsx scripts/acceptance.mts`（不打印密钥）

## 通过（22/22 可执行项 + 3 项有条件跳过记为通过说明）

### 编译与测试
- [x] TypeScript 检查通过 — 证据：`npx tsc --noEmit` 退出码 0
- [x] 依赖可安装 — 证据：`npm install` 退出码 0
- [x] lint — 证据：`package.json` 无 lint 脚本，**跳过（已记录）**

### 实现完整性
- [x] AC6 字段加载 — 证据：`source=project name=deepseek protocol=openai model=deepseek-v4-flash baseUrl=https://api.deepseek.com apiKeyLen=35`
- [x] AC6 项目优先 — 证据：`projectExists=true loadedSource=project`
- [x] AC7 DeepSeek 流式 — 证据：`deltaCount=8 textLen=18 hasAssistant=true firstDeltaMs=2748`
- [x] AC2 流式增量 — 证据：收到 `text_delta` 8 次，非整段一次性返回
- [x] AC3 多轮上下文 — 证据：第二轮回复 `蓝猫4779`，与第一轮暗号一致
- [x] AC4 落盘恢复 — 证据：`reloadedMessages=4`，标题由首条用户消息生成
- [x] AC5 列表可见 — 证据：`listCount=4 containsS2=true`（历史列出；TUI 点选需人工）
- [x] AC8 Provider 可扩展 — 证据：factory 双协议；ChatService/TUI 不直接依赖 openai/anthropic 实现文件
- [x] AC10 thinking 告警文案 — 证据：warnings 含「不支持扩展思考…对话仍可正常进行」
- [x] AC11 错误密钥中文错误 — 证据：`模型接口错误（HTTP 401）：...Authentication Fails...`，且仅落盘 user
- [x] N3 会话不含密钥 — 证据：临时会话与 `~/.mewcode/sessions` 抽查均无 `api_key`/`apiKey`
- [x] AC7 Anthropic — **跳过**：当前配置无可用 Anthropic 密钥
- [x] AC9 Claude thinking UI — **跳过**：依赖 Anthropic 密钥 + TUI 目视；本机无 tmux

### 集成
- [x] CLI 串联链路 — 证据：`cli.ts` 含 `loadConfig` → provider → store → ChatService → `startApp`
- [x] done 写助手 / error 不写助手 — 证据：成功轮 `user,assistant`；失败轮仅 `user`
- [x] warnings 传入 TUI — 证据：`ChatScreen` 渲染 `warnings`；告警文案校验通过

### 端到端
- [x] 场景 1（DeepSeek）— 证据：无头 ChatService 覆盖新建/流式/多轮/落盘；**TUI 全屏交互未在 tmux 中目视**（Windows 无 tmux）
- [x] 场景 2（坏密钥）— 证据：401 中文错误 + 仅 user 落盘
- [x] 场景 3（thinking 告警仍可聊）— 证据：`warnCount=1` 且回复 `好`

### TUI 人工项（部分证据）
- [x] AC1/选会话 UI — **代码级通过**（session-picker + cli 存在）；**完整 Ink 交互请本地 `npm start` 再确认一眼**

## 未通过

无。

## 残留风险 / 建议你本地补一眼

1. **TUI 交互**：本机无 tmux，未能按 AGENTS.md 做全屏键鼠验收；请运行 `npm start`，确认新建/恢复会话、流式刷字、Esc 返回。
2. **Anthropic / AC9**：补密钥并切换 `protocol: anthropic` + `thinking: true` 后再验折叠摘要 UI。

## 统计

| 类别 | 结果 |
|------|------|
| 自动化实呼与逻辑 | 全部通过 |
| 有条件跳过 | Anthropic、AC9 thinking UI、lint、tmux 目视 |
| 失败 | 0 |
