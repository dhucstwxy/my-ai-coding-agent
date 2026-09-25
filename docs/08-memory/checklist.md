# 记忆与会话 Checklist

> 每一项通过运行代码或观察行为来验证，聚焦系统行为。

## 实现完整性

- [ ] 三层 AGENTS.md 按「根 → .mewcode → 用户」顺序进入自定义指令槽（验证：临时三层不同文案，检查 buildPrompt / 发出的 system 前缀）
- [ ] 缺某一层时其余仍加载、不抛错（验证：只留用户级文件仍能启动并注入）
- [ ] 合法 @include 展开；深度>5 / 环路 / 路径逃逸被跳过且有警告（验证：tsx 临时目录用例）
- [ ] 指令总长超过 100KB 时截断并警告（验证：超大 AGENTS.md）
- [ ] 新建会话落在项目 `.mewcode/sessions/YYYYMMDD-HHMMSS-xxxx.jsonl`（验证：create 后文件系统）
- [ ] 不再读写全局 `~/.mewcode/sessions/*.json` 作为主存储（验证：Store 构造目录为项目路径）
- [ ] 会话列表无独立 meta 文件仍能显示标题与规模（验证：list 输出）
- [ ] JSONL 坏行可跳过；未配对工具尾被截断（验证：造坏文件 get）
- [ ] 距上次活动 >24h 的继续对话请求含时间跨度提醒（验证：改 lastMessageAt 或造旧 createdAt）
- [ ] 启动清理删除 >30 天未更新会话及其 tool-results 目录（验证：造旧文件后跑 cleanup）
- [ ] 记忆索引注入记忆槽，且不超过 200 行 / 25KB（验证：超大 INDEX）
- [ ] 自然完成（无工具调用）后异步写入笔记或更新 INDEX；用户/项目目录隔离（验证：假 Provider + 查 memory 目录）
- [ ] 取消/报错路径不触发记忆更新（验证：打桩 schedule 调用次数）
- [ ] 记忆更新失败时界面无错误、主对话仍 completed（验证：Updater 抛错）
- [ ] 工具结果落盘在 `.mewcode/sessions/{id}/tool-results/`（验证：micro 压缩或 writeToolResult）

## 集成

- [ ] AgentLoop 的 buildPrompt 实际带上 customInstructions 与 memoryText（验证：非空文件时 system/sections 含关键词）
- [ ] 每轮请求前仍走 ContextPipeline；超大恢复会话会被压缩（验证：超限历史 + 假/真请求前观察 compact 事件或消息变短）
- [ ] cli 启动执行 cleanup，并把 instructions/memory 警告并入界面 warnings（验证：启动日志/界面）
- [ ] `.gitignore` 包含 `.mewcode/sessions/`（验证：读文件）

## 编译与测试

- [ ] `npm run typecheck` 退出码 0
- [ ] 本步新增的临时验证脚本均通过（跑完删除）
- [ ] lint（如有配置）通过；未配置则记跳过

## 端到端场景

- [ ] 场景 1（指令）：在项目根与 `.mewcode/` 写入不同 AGENTS.md，启动对话，模型行为或日志中可见高优先级规范被遵循 / system 含两段文案
- [ ] 场景 2（会话）：新建会话 → 多轮追加 → 重启进程 → 同一会话可从列表打开且历史还在；手动在 JSONL 插一行垃圾仍能打开
- [ ] 场景 3（时间提醒）：将会话最后消息时间拨到 25h 前，再发一条，请求侧出现「间隔很久」类提醒
- [ ] 场景 4（记忆）：完成一轮无工具回复后，稍后在 `.mewcode/memory/` 或 `~/.mewcode/memory/` 看到 INDEX/笔记变化；回复展示后可立刻输入下一句
- [ ] 场景 5（清理）：造一个 31 天前的 jsonl，重启后文件消失

## Spec 对照

| Spec | Checklist |
|------|-----------|
| AC1 | 实现完整性 1–2 |
| AC2 | 实现完整性 3 |
| AC3 | 集成 1 + 指令不写入 JSONL（抽查会话文件） |
| AC4 | 实现完整性 5–6 |
| AC5 | 实现完整性 7 |
| AC6 | 实现完整性 8–9 + 集成 2 |
| AC7 | 实现完整性 10 + 端到端 5 |
| AC8 | 实现完整性 12 + 端到端 4 |
| AC9 | 实现完整性 11 |
| AC10 | 实现完整性 13–14 |
| AC11 | 实现完整性 15 |
| AC12 | 端到端 4 |
