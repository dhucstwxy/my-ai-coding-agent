# MewCode Agent Loop Checklist

> 每一项通过运行代码或观察行为验证。默认联调：DeepSeek。TUI 项可在本机终端目视（不强制 tmux）。

## 实现完整性

- [ ] 一次提问可触发多轮「模型 + 工具」自主衔接，无需逐步催促（验证：真实小任务或验收脚本观察 ≥2 次工具执行后结束）（AC1/AC15）
- [ ] 模型不再调工具时循环结束并有最终文本（验证：事件含 `agent_stopped` reason=completed 或等价完成态 + 可见文本）（AC2）
- [ ] 迭代上限生效（验证：将 maxIterations 设为 1 或 2 且模型持续要工具 → 停止并提示达到上限）（AC3）
- [ ] 忙碌 Esc 取消（验证：循环中按 Esc → 停止并提示已取消；空闲 Esc 返回会话列表）（AC4）
- [ ] 连续两次未知工具停止（验证：注入/mock 连续两个未知工具名 → `unknown_tools` 停止说明）（AC5）
- [ ] 不可恢复错误停止且进程不崩（验证：坏密钥或 mock 流错误 → 中文错误 + 进程仍在）（AC6）
- [ ] 仅通过事件流可观察文本/工具/进度（验证：订阅异步迭代可见 text_delta、tool_execution_*、agent_progress；UI 不 import loop 内部私有状态）（AC7）
- [ ] 双路流：过程中有增量文本，结束后能按完整 toolCalls 分支（验证：流式中见 delta；有工具则执行，无则结束）（AC8）
- [ ] 只读并发、副作用串行（验证：双只读 delay mock 总耗时≈并行；write 在只读之后）（AC9）
- [ ] 工具结果落盘可恢复（验证：多轮后打开会话文件或重启可见 tool 消息）（AC10）
- [ ] `/plan` 仅三只读工具（验证：filter 长度为 3；或 plan 模式下写类不在请求 tools 列表）（AC11）
- [ ] `/do` 恢复全工具且 UI 有模式提示（验证：mode_changed + 界面「执行模式」；definitions 长度为 6）（AC12）
- [ ] DeepSeek 多步循环成功（验证：验收脚本或手工一次多步任务）（AC13）
- [ ] Anthropic 多步循环（验证：有密钥则跑；无则跳过并注明）（AC13）
- [ ] TUI 可见进度、工具摘要、停止原因（验证：目视 progress 与 stopped 文案）（AC14）

## 集成

- [ ] ChatService 不再走「只执行第一个工具 + 二次禁工具」旧路径（验证：代码路径走 AgentLoop；行为上同批可执行多个只读）
- [ ] Facade 正确处理仅 `/plan`、`/plan 任务`、`/do`、普通文本（验证：模式切换事件与是否启动 Loop）
- [ ] CancelToken 在 Facade 与 TUI 间共享（验证：cancel 后 Loop 停止）

## 编译与测试

- [ ] `npm run typecheck` 退出码 0
- [ ] `npm install` 可重复成功（如有依赖变更）
- [ ] lint：无则跳过并记录

## 端到端场景

- [ ] 场景 1：执行模式下「读 A 再根据内容读 B」一次发送 → 自主多步完成（AC15）
- [ ] 场景 2：`/plan` 后只读探索出文字计划；再 `/do` 允许写/命令（若任务需要）
- [ ] 场景 3：循环中 Esc 取消 → 可继续新输入
- [ ] 场景 4：故意连续未知工具（测试）→ 停止说明
