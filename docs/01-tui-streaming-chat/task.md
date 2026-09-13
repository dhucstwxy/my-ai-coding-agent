# MewCode 交互式流式对话 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 修改 | `package.json` | 包名、bin、scripts、依赖（tsx/ink/react/yaml 等） |
| 新建 | `tsconfig.json` | TypeScript ESM 配置 |
| 新建 | `.mewcode/config.example.yaml` | DeepSeek 默认示例（无真实密钥） |
| 新建 | `src/config/types.ts` | AppConfig、ProviderConfig、LoadConfigResult |
| 新建 | `src/config/paths.ts` | 项目/用户配置与会话目录路径 |
| 新建 | `src/config/validate.ts` | 字段校验与 thinking 告警 |
| 新建 | `src/config/load.ts` | ConfigLoader.load |
| 新建 | `src/provider/types.ts` | ChatProvider、ChatRequest、StreamEvent |
| 新建 | `src/provider/factory.ts` | ProviderFactory.create |
| 新建 | `src/provider/openai.ts` | OpenAI 兼容 SSE（含 DeepSeek） |
| 新建 | `src/provider/anthropic.ts` | Anthropic SSE + 扩展思考 |
| 新建 | `src/session/types.ts` | Session、ChatMessage、SessionSummary |
| 新建 | `src/session/store.ts` | SessionStore 文件落盘 |
| 新建 | `src/chat/service.ts` | ChatService.send |
| 新建 | `src/tui/message-list.tsx` | 消息、流式正文、思考摘要 |
| 新建 | `src/tui/session-picker.tsx` | 历史列表 + 新建 |
| 新建 | `src/tui/chat-screen.tsx` | 对话屏、输入、告警 |
| 新建 | `src/tui/app.tsx` | 选会话 / 对话路由 |
| 新建 | `src/tui/index.tsx` | startApp(deps) |
| 新建 | `src/cli.ts` | 组装依赖并启动 |
| 新建 | `src/index.ts` | 进程入口 |
| 新建 | `README.md` | 中文安装/配置/启动说明 |
| 新建 | `.gitignore` | 忽略 node_modules、本地 config.yaml、sessions 等 |

## T1: 初始化 TypeScript 工程

**文件：** `package.json`、`tsconfig.json`、`.gitignore`  
**依赖：** 无  
**步骤：**
1. 将包名改为 `mewcode`，设置 `"type": "module"`
2. 添加依赖：`ink`、`react`、`yaml`；开发依赖：`typescript`、`tsx`、`@types/node`、`@types/react`
3. 添加 scripts：`start` → `tsx src/index.ts`；`bin` 指向入口
4. 编写 `tsconfig.json`（ESM、jsx react、strict）
5. 编写 `.gitignore`（`node_modules`、`.mewcode/config.yaml`、可选本地密钥文件）

**验证：** 在项目根执行 `npm install`，退出码为 0；`npx tsc --noEmit` 在尚无源码时报错可接受，但 `tsconfig.json` 可被读取

## T2: 配置类型与路径

**文件：** `src/config/types.ts`、`src/config/paths.ts`  
**依赖：** T1  
**步骤：**
1. 按 plan 定义 `ProviderConfig`、`AppConfig`、`LoadConfigResult`
2. 实现项目配置路径 `./.mewcode/config.yaml`、用户配置 `~/.mewcode/config.yaml`、会话目录 `~/.mewcode/sessions`

**验证：** `npx tsc --noEmit` 针对上述文件无类型错误（可暂时只检查这些文件或等入口齐后再统一）

## T3: 配置校验

**文件：** `src/config/validate.ts`  
**依赖：** T2  
**步骤：**
1. 校验 `active`/`activeProvider`、providers 列表及每条必填字段
2. `protocol` 仅允许 `anthropic` | `openai`
3. 当 `thinking: true` 且 `protocol === "openai"` 时，加入中文 `warnings`，不视为硬失败
4. `active` 找不到对应 `name` 时抛出/返回中文错误

**验证：** 用临时脚本或后续单测思路：构造 openai+thinking 的配置对象，断言 `warnings` 非空；缺 `api_key` 时校验失败

## T4: 配置加载

**文件：** `src/config/load.ts`  
**依赖：** T3  
**步骤：**
1. 若项目配置存在则读项目，否则读用户配置；都不存在则中文错误说明如何复制 example
2. 用 `yaml` 解析；映射顶层 `active` → `activeProvider`
3. 调用 validate，返回 `LoadConfigResult`（含 `source`）

**验证：** 准备临时 YAML（可指向测试路径或手动放置 `.mewcode/config.yaml` 后）调用 `load()`，`source` 为 `project` 且能解析出 deepseek 条目

## T5: DeepSeek 示例配置

**文件：** `.mewcode/config.example.yaml`  
**依赖：** T4（可并行于实现，逻辑上接在配置约定后）  
**步骤：**
1. 写入 `active: deepseek`
2. 一条 provider：`name: deepseek`，`protocol: openai`，`model: deepseek-v4-flash`，`base_url: https://api.deepseek.com`，`api_key: YOUR_API_KEY`
3. 可选注释掉的 anthropic 示例块（无真实密钥）

**验证：** 目视无真实密钥；字段名与 plan 一致；复制为 `config.yaml` 后可被 T4 加载（密钥仍为占位则后续请求会失败，属预期）

## T6: Provider 类型与工厂

**文件：** `src/provider/types.ts`、`src/provider/factory.ts`  
**依赖：** T2  
**步骤：**
1. 定义 `StreamEvent`、`ChatRequest`、`ChatProvider`
2. `create(config)`：`openai` → OpenAI 实现，`anthropic` → Anthropic 实现，未知 protocol 中文报错
3. 先可用占位类抛「未实现」，在 T7/T8 替换（或 T6 只写类型+工厂骨架，T7/T8 补全）

**验证：** 对 `protocol: "openai"` 调用 factory 返回的对象 `protocol === "openai"` 且 `supportsThinking === false`

## T7: OpenAI 兼容流式 Provider（DeepSeek 默认路径）

**文件：** `src/provider/openai.ts`  
**依赖：** T6  
**步骤：**
1. 实现 `streamChat`：`POST {baseUrl}/chat/completions`（注意 baseUrl 是否已含 `/v1`，按 DeepSeek 文档规范化）
2. `stream: true`，Authorization Bearer
3. 解析 SSE `data:` 行，产出 `text_delta`，结束时 `done`；HTTP 错误映射为中文 `error`
4. 不发送 thinking 相关参数

**验证：** 配置真实 DeepSeek 密钥后，写一小段异步迭代脚本消费 `streamChat`，终端能看到逐步 `text_delta` 文本（或先 mock 一段 SSE fixture 断言事件序列）

## T8: Anthropic 流式 Provider + thinking

**文件：** `src/provider/anthropic.ts`  
**依赖：** T6  
**步骤：**
1. Messages API 流式请求；`thinking: true` 时带扩展思考参数
2. 将 content/thinking 相关 SSE 映射为 `text_delta` / `thinking_*` / `done` / `error`
3. `supportsThinking = true`
4. `thinking_end.summary`：由思考文本截断生成短摘要（例如前 N 字）

**验证：** 有 Anthropic 密钥时实呼一轮；无密钥时用构造的 SSE 片段单测映射逻辑，断言 thinking 与 text 事件类型正确

## T9: 会话类型与 Store

**文件：** `src/session/types.ts`、`src/session/store.ts`  
**依赖：** T2  
**步骤：**
1. 实现 `list` / `create` / `get` / `appendMessage` / `updateTitle`
2. 会话文件 JSON 存于 `~/.mewcode/sessions/<id>.json`
3. 首条用户消息可截断更新 `title`
4. 确保序列化对象中无 `apiKey` 字段

**验证：** create → append 两条消息 → list 可见 → 进程外再 `get` 内容一致；文件内容 grep 不到 api_key

## T10: ChatService 编排

**文件：** `src/chat/service.ts`  
**依赖：** T7（或 T8）、T9  
**步骤：**
1. `send`：append user → 读全量 messages → `streamChat` → 透传事件
2. 聚合 `text_delta` 为助手 `content`；聚合 thinking 为 `thinkingSummary`
3. 收到 `done` 时 append assistant；收到 `error` 时不写助手成功消息

**验证：** 使用假 Provider（异步产出固定 delta）跑 `send`，断言会话中最终有 user+assistant；假 Provider 产出 error 时仅有 user 消息

## T11: TUI 消息列表

**文件：** `src/tui/message-list.tsx`  
**依赖：** T1  
**步骤：**
1. 渲染历史消息（用户/助手）
2. 流式中的助手正文增量显示
3. 思考区默认折叠/摘要（显示「思考中…」或 `thinkingSummary`），不全文刷屏

**验证：** 用 Ink 临时入口传入 mock messages，目视布局符合预期

## T12: TUI 会话选择

**文件：** `src/tui/session-picker.tsx`  
**依赖：** T9、T11（可仅依赖 T9）  
**步骤：**
1. 展示 `SessionStore.list()` 摘要（标题、更新时间）
2. 支持选择已有会话与「新建会话」
3. 中文文案

**验证：** 预置 1 个会话文件后启动该组件，列表可见且可选

## T13: TUI 对话屏

**文件：** `src/tui/chat-screen.tsx`  
**依赖：** T10、T11  
**步骤：**
1. 展示消息列表与输入框
2. 提交后调用 `ChatService.send`，消费流事件更新 UI
3. 展示 config `warnings` 与流式 `error` 中文信息
4. 流式期间防止重复提交（禁用输入或忽略二次提交）

**验证：** 接 DeepSeek 配置后，输入一句话可见流式输出；错误密钥时见中文错误且可再次输入

## T14: TUI 根应用与挂载

**文件：** `src/tui/app.tsx`、`src/tui/index.ts`  
**依赖：** T12、T13  
**步骤：**
1. `app.tsx`：picker ↔ chat 状态切换；新建/恢复会话
2. `startApp(deps)` 渲染根组件并传入 store/service/warnings

**验证：** `startApp` 可进入 picker；新建后进入空对话屏

## T15: CLI 入口串联

**文件：** `src/cli.ts`、`src/index.ts`  
**依赖：** T4、T6、T9、T10、T14  
**步骤：**
1. `load()` → factory → SessionStore → ChatService → `startApp`
2. 顶层 try/catch 打印中文错误
3. `index.ts` 调用 cli

**验证：** `npm start` 在有效 DeepSeek 配置下进入会话选择界面（AC1）

## T16: README

**文件：** `README.md`  
**依赖：** T5、T15  
**步骤：**
1. 说明复制 `config.example.yaml` → `config.yaml`、填写 DeepSeek 密钥
2. `npm install` / `npm start`
3. 简述会话目录与双协议切换

**验证：** 按 README 步骤可完成一次启动（人工对照）

## 执行顺序

```
T1 → T2 → T3 → T4 → T5
         ↘
          T6 → T7 → T10 ─┐
               T8 ───────┤（T8 可与 T7 并行，T10 至少依赖其一；建议先 T7）
         T9 ─────────────┘
T1 → T11 → T12 → T13 → T14 → T15 → T16
           ↑
          T9
```

推荐串行落地顺序：  
`T1 → T2 → T3 → T4 → T5 → T6 → T7 → T9 → T10 → T8 → T11 → T12 → T13 → T14 → T15 → T16`
