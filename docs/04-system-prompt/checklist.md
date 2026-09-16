# MewCode 结构化系统提示 Checklist

> 每一项通过运行代码或观察行为来验证，聚焦系统行为。  
> 默认联调：DeepSeek `deepseek-v4-flash`。端到端按 `AGENTS.md` 优先在 tmux/本机终端观察。

## 实现完整性

- [ ] 系统提示按约定模块顺序拼装，模块间空行分隔；可选三槽本轮为空且不破坏扩展顺序（验证：对 `PromptBuilder.build` 输出检查章节顺序与关键字）（AC1）
- [ ] 固定七模块 `stableSystem` 在相同输入下两次拼装字节一致；环境变化不改变 stable（验证：固定 `now` 两次相等；换 workspace 后 stable 仍等、reminder/环境文本变）（AC2）
- [ ] stable 中可识别身份、约束、计划/执行、动作执行、工具使用、语气、输出要求（验证：关键字抽查）（AC3）
- [ ] 环境信息含工作区路径、时间、平台；不插入稳定七模块中间（验证：reminder 或装配快照中环境在标签内；stable 无动态路径）（AC4）
- [ ] 六个工具 description 含「专用工具 / 先读」类强化（验证：`toDefinitions()` 文本抽查）（AC5）
- [ ] 请求装配含 `<system-reminder>`；全局指令说明不得当作用户提问（验证：装配快照或调试日志 + sections 原文）（AC6）
- [ ] reminder 不落盘、TUI 不显示为用户气泡（验证：会话 JSON 无 system-reminder；界面无对应「你」气泡）（AC7）
- [ ] 计划模式控频：第 1 轮 full、第 2–4 轮 brief、第 6 轮 reinforce（验证：对 ReminderBuilder 单测/脚本按 iteration 断言 kind）（AC8）
- [ ] DeepSeek 连续两轮请求可解析 cache hit/miss 字段并向上暴露（验证：第二轮日志/TUI 出现数值或 0；字段存在）（AC9）
- [ ] Anthropic 有密钥时 system/tools 带缓存标记且用量可解析；无密钥跳过并注明（验证：有密钥联调 / 无则记录跳过）（AC10）
- [ ] 无 cache 字段时显示不可用，不伪造命中（验证：构造无字段 usage 或关字段路径，UI/事件 `cacheAvailable===false`）（AC11）
- [ ] `eval-scenarios.md` 至少 3 个可执行对比场景（验证：打开文档点数）（AC12）
- [ ] Agent Loop 多步工具、`/plan` 过滤、Esc 取消仍可用（验证：小任务多步 + `/plan` 后不可写文件类工具暴露）（AC13）
- [ ] 拼装失败时进程不崩，有中文错误/停止原因（验证：临时注入抛错或无效输入路径）（AC14）

## 集成

- [ ] AgentLoop 每轮将 `system: stableSystem` 交给 Provider，且 messages 前缀含 reminder、其后为真实历史
- [ ] SessionStore.appendMessage 路径在循环中从不写入 reminder
- [ ] `token_usage` 经 collector → loop → TUI 链路可到达（有 API 时）

## 编译与测试

- [ ] `npm run typecheck` 退出码 0
- [ ] `npm start` 可进入 TUI
- [ ] lint 未配置则记跳过

## 端到端场景

- [ ] 场景 1（DeepSeek 缓存）：同一会话连续两轮简单提问，观察第二轮 cache hit/miss 可解析且 TUI/日志可见（AC9）
- [ ] 场景 2（工具遵守定性）：按 `eval-scenarios.md` 跑「编辑前先读」任务，人工记录是否先 `read_file` 再 `edit_file`（AC12）
- [ ] 场景 3（Plan 提醒 + 过滤）：`/plan` 后发任务，确认只读工具可用；用调试或脚本确认第 1/6 轮 reminder 强度不同（AC8、AC13）
- [ ] 场景 4（回归）：`/do` 后多步改文件小任务仍能自主完成；Esc 取消仍有效（AC13）
