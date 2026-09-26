# 斜杠命令 Checklist

> 每一项通过运行代码或观察行为来验证，聚焦系统行为。

## 实现完整性

- [ ] 命令注册中心可登记名称/别名/描述/用法/类型/handler（验证：typecheck + 注册后 get 成功）
- [ ] 别名冲突时启动失败，错误含冲突名（验证：故意双注册抛错或 exit 非 0）
- [ ] `/HELP` 与 `/help` 等效；空输入无副作用（验证：parse 断言 + 手动回车）
- [ ] 未知 `/foo` 不进 AI，并提示 `/help`（验证：打桩 Provider 无调用 + 界面文案）
- [ ] 普通文本仍进 AI（验证：打桩 runLoop/Provider 被调用）
- [ ] Tab：唯一匹配补全；多匹配出候选；hidden 不出现（验证：complete 单测 + 终端 Tab）
- [ ] `/help` 列出可见命令与用法（验证：执行后界面输出）
- [ ] `/compact` 可带备注触发手动压缩（验证：观察 compact 事件或会话变短）
- [ ] `/clear` 清空界面列表，JSONL 文件内容仍在（验证：clear 后读文件）
- [ ] `/plan`/`/do` 无参只切模式；有参切模式并送正文（验证：状态栏 + 是否进入对话）
- [ ] `/session` 含 ID/标题/消息数/路径（验证：输出字段）
- [ ] `/memory` 含 INDEX 路径与规模概况（验证：输出字段）
- [ ] `/permission` 与 `/perm` 均可改档；非法参数提示用法（验证：状态栏短标）
- [ ] `/status` 含模式、权限、会话短讯、token/缓存或占位、熔断状态（验证：输出）
- [ ] `/review` 送出审查提示并进入 AI 回合（验证：界面出现用户侧提示与模型回复）
- [ ] 状态栏显示 `[PLAN|DEFAULT · STRICT|DEFAULT|ALLOW]`（验证：切换后顶栏）

## 集成

- [ ] ChatService 不再使用旧 parseCompact/parseSlash/parsePerm（验证：代码检索无残留调用）
- [ ] cli 使用 buildDefaultRegistry；正常启动十命令可用（验证：`pnpm start` 后 `/help`）
- [ ] 本地命令 help/clear/status 不触发模型请求（验证：打桩 Provider）
- [ ] submitToAgent 路径不二次命令解析（验证：`/plan 做某事` 进入 Loop 的是正文）

## 编译与测试

- [ ] `npm run typecheck` 退出码 0
- [ ] 本步临时验证脚本通过（跑完删除）
- [ ] lint（如有）通过；无则跳过

## 端到端场景

- [ ] 场景 1：启动 → `/help` → 看到十个可见命令
- [ ] 场景 2：`/plan` → 顶栏 `[PLAN]` → `/do` → `[DEFAULT]`
- [ ] 场景 3：输入若干对话 → `/clear` → 屏幕空 → 重开同会话历史仍在
- [ ] 场景 4：`/c` + Tab → 补全或候选；`/unknown` → 引导 help 且无模型调用
- [ ] 场景 5：`/review` → 模型开始审查回复；`/status` 可查看熔断/token 概况

## Spec 对照

| Spec | Checklist |
|------|-----------|
| AC1 | 实现完整性 1–2 |
| AC2 | 实现完整性 3–4 |
| AC3 | 实现完整性 5 + 集成 3 |
| AC4 | 实现完整性 10、16 |
| AC5 | 实现完整性 6 + 端到端 4 |
| AC6 | 实现完整性 7 |
| AC7 | 实现完整性 8 |
| AC8 | 实现完整性 9 + 端到端 3 |
| AC9 | 实现完整性 10 |
| AC10 | 实现完整性 11–12、14 |
| AC11 | 实现完整性 13 |
| AC12 | 实现完整性 15 + 端到端 5 |
| AC13 | 集成 3 |
