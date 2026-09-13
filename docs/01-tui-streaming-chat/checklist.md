# MewCode 交互式流式对话 Checklist

> 每一项通过运行代码或观察行为来验证，聚焦系统行为。  
> 默认联调模型：DeepSeek `deepseek-v4-flash`（OpenAI 兼容协议）。端到端按 `AGENTS.md` 优先在 tmux 中观察。

## 实现完整性

- [ ] 可通过文档中的启动命令进入交互界面（验证：`npm start` 后停留在可选会话/可输入状态，而非立即退出）（AC1）
- [ ] 提交用户问题后，助手回复以流式逐渐出现（验证：tmux 中目视字符/片段陆续出现，而非长时间空白后整段弹出）（AC2）
- [ ] 多轮上下文生效（验证：第一轮告知一个独特事实，第二轮询问该事实，回复能引用）（AC3）
- [ ] 会话落盘可恢复（验证：对话一轮后退出，再启动，历史中可见该会话及关键用户/助手内容）（AC4）
- [ ] 启动可选历史或新建（验证：完成「选中已有会话继续」与「新建会话」各一次）（AC5）
- [ ] YAML 六字段生效（验证：修改 `name`/`protocol`/`model`/`base_url`/`api_key`/`thinking` 后行为与配置一致）（AC6）
- [ ] 项目配置优先于用户配置（验证：两边都有配置且 `active`/模型不同时，实际请求使用项目侧配置）（AC6）
- [ ] DeepSeek（OpenAI 兼容）流式对话成功（验证：`active: deepseek` + 真实密钥，完成至少一轮流式回复）（AC7）
- [ ] Anthropic 流式对话成功（验证：有密钥时切换 `protocol: anthropic` 完成一轮；无密钥则标记为跳过并注明原因）（AC7）
- [ ] Provider 可扩展（验证：调用侧只依赖统一流式接口/工厂；`openai` 与 `anthropic` 为并列实现，无 UI/编排直接绑定某一家私有类型）（AC8）
- [ ] Claude + thinking 折叠展示（验证：Anthropic 且 `thinking: true` 时，界面为摘要/折叠态，正文仍流式；无密钥则跳过并注明）（AC9）
- [ ] 不支持 thinking 时告警仍可聊（验证：DeepSeek/openai 配置 `thinking: true`，界面有中文告警且仍能流式对话）（AC10）
- [ ] 错误密钥/地址有中文错误（验证：错误 `api_key` 或错误 `base_url` 时 UI 显示可读中文错误，进程不崩溃）（AC11）
- [ ] 会话文件不含密钥（验证：打开 `~/.mewcode/sessions/*.json`，内容中无 `api_key`/密钥字符串）（N3）

## 集成

- [ ] CLI 能完成「加载配置 → 创建 Provider → SessionStore → ChatService → TUI」整链（验证：合法配置下 `npm start` 进入 picker）
- [ ] ChatService 在 `done` 后写入助手消息，在 `error` 后不写入助手成功消息（验证：成功轮落盘有 assistant；故意失败轮仅有 user）
- [ ] 配置告警传入 TUI 可见（验证：openai + `thinking: true` 时对话屏出现告警文案）

## 编译与测试

- [ ] TypeScript 检查通过（验证：`npx tsc --noEmit` 退出码 0）
- [ ] 依赖可安装（验证：`npm install` 退出码 0）
- [ ] 若已配置 lint 脚本则通过；未配置则记「未配置，跳过」（验证：查看 `package.json` scripts）

## 端到端场景

- [ ] 场景 1（默认 DeepSeek / tmux）：在 tmux 中启动 MewCode → 新建会话 → 输入真实问题 → 观察工具未调用（本轮无 tool）且流式回复正常 → 再问一句依赖上文的问题 → 退出再启动能从历史恢复（验证：逐步对照 AC1–AC5、AC7 DeepSeek）
- [ ] 场景 2（边界：坏密钥）：配置错误 `api_key` → 发送一句话 → 看到中文错误 → 仍可继续输入（验证：AC11）
- [ ] 场景 3（边界：thinking 告警）：DeepSeek 配置 `thinking: true` → 启动后可见告警 → 仍可完成一轮对话（验证：AC10）
