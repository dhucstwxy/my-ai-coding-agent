# MewCode 交互式流式对话 Plan

## 架构概览

按「配置 → 会话 → Provider → TUI」四层划分，满足 F1–F11，本轮无 tool。

| 组件 | 职责 |
|------|------|
| **入口 CLI** | 解析启动命令，组装依赖，拉起 TUI；捕获未处理错误并输出中文提示 |
| **配置加载** | 按「项目配置优先 → 用户目录回退」读 YAML；校验字段；选出当前供应商；`thinking` 与协议不匹配时生成告警供 UI 展示 |
| **会话存储** | 列出/创建/读写本地会话；消息追加落盘；不持久化 `api_key` |
| **Provider 抽象** | 统一「流式对话」接口；按 `protocol` 创建具体实现 |
| **Anthropic 实现** | SSE 流式请求；可选扩展思考；映射为统一流事件 |
| **OpenAI 实现** | SSE 流式请求；忽略不支持的 thinking（由配置层已告警） |
| **对话编排** | 取会话历史 → 调 Provider 流 → 把增量写回会话 → 把事件推给 UI |
| **TUI** | 启动选会话/新建；输入与提交；正文流式渲染；思考折叠/摘要；错误与告警展示 |

数据流（一轮提问）：

```
用户输入 → 对话编排 → Provider.stream → SSE 事件
                ↓                    ↓
           会话落盘 ←—————— 统一流事件 → TUI 渲染
```

与 spec 对应：F1/F5→TUI+入口；F2/N2→Provider+SSE+TUI；F3/F4→会话+编排；F6/F7→配置；F8/F9→双实现+抽象；F10/F11→思考展示与告警。

## 核心数据结构

### AppConfig
- `activeProvider: string` — 当前启用的供应商标识，对应某条 `name`
- `providers: ProviderConfig[]` — 供应商列表

### ProviderConfig
- `name: string`
- `protocol: "anthropic" | "openai"`
- `model: string`
- `baseUrl: string`
- `apiKey: string`
- `thinking?: boolean`

### LoadConfigResult
- `config: AppConfig`
- `source: "project" | "user"` — 实际生效的配置来源
- `warnings: string[]` — 如「当前协议不支持 thinking」等中文告警

### ChatMessage
- `id: string`
- `role: "user" | "assistant" | "system"`
- `content: string` — 对用户可见的正文（助手消息不含密钥）
- `thinkingSummary?: string` — 可选的思考摘要（非全文展开用）
- `createdAt: string` — ISO 时间

### Session
- `id: string`
- `title: string` — 列表展示用（可由首条用户消息截断生成）
- `createdAt: string`
- `updatedAt: string`
- `messages: ChatMessage[]`

### SessionSummary
- `id: string`
- `title: string`
- `updatedAt: string`

### StreamEvent
- `{ type: "text_delta"; text: string }`
- `{ type: "thinking_start" }`
- `{ type: "thinking_delta"; text: string }` — 供生成摘要，UI 默认不全文展示
- `{ type: "thinking_end"; summary: string }`
- `{ type: "error"; message: string }` — 已转成可读中文
- `{ type: "done" }`

### ChatRequest
- `messages: ChatMessage[]`
- `model: string`
- `thinking?: boolean`

### ChatProvider
- `readonly protocol: "anthropic" | "openai"`
- `supportsThinking: boolean`
- `streamChat(request: ChatRequest): AsyncIterable<StreamEvent>`

### ProviderFactory
- `create(config: ProviderConfig): ChatProvider`

### ConfigLoader
- `load(): LoadConfigResult`

### SessionStore
- `list(): SessionSummary[]`
- `create(title?: string): Session`
- `get(id: string): Session | null`
- `appendMessage(sessionId: string, message: ChatMessage): void`
- `updateTitle(sessionId: string, title: string): void`

### ChatService
- `send(sessionId: string, userText: string): AsyncIterable<StreamEvent>`

## 模块设计

### 入口 CLI（`src/cli.ts` / `src/index.ts`）
**职责：** 启动进程、加载配置、构造 Provider/SessionStore/ChatService、挂载 TUI；顶层错误转中文后退出。  
**对外接口：** 进程入口（如 `mewcode` / `npm start`）。  
**依赖：** ConfigLoader、ProviderFactory、SessionStore、ChatService、TUI。

### 配置模块（`src/config/`）
**职责：** 解析 YAML；合并查找路径；校验必填字段；选出 `activeProvider`；若 `thinking: true` 且协议不支持则写入 `warnings`。  
**对外接口：** `ConfigLoader.load()`。  
**依赖：** 文件系统、YAML 解析库。  
**路径约定：** 项目：`./.mewcode/config.yaml`；用户：`~/.mewcode/config.yaml`。  
**开发/验收默认供应商：** 示例配置与本地联调优先使用 DeepSeek（`protocol: openai`，`model: deepseek-v4-flash`，`base_url: https://api.deepseek.com`）；Anthropic 配置保留供协议切换与扩展思考验收，不作为默认 `active`。

### Provider 模块（`src/provider/`）
**职责：** 定义 `ChatProvider` / `StreamEvent`；工厂按 `protocol` 创建实现。  
**对外接口：** `ProviderFactory.create`、`ChatProvider.streamChat`。  
**依赖：** 无业务 UI；仅依赖 HTTP/SSE 与配置中的连接信息。

### Anthropic Provider
**职责：** 按 Anthropic Messages 流式协议请求；`thinking` 开启时带扩展思考；将 SSE 转为统一 `StreamEvent`。  
**对外接口：** 实现 `ChatProvider`（`supportsThinking = true`）。  
**依赖：** `baseUrl`、`apiKey`、`model`。

### OpenAI Provider
**职责：** 按 OpenAI Chat Completions（或兼容）流式协议请求；不发送思考参数。  
**对外接口：** 实现 `ChatProvider`（`supportsThinking = false`）。  
**依赖：** 同上。

### 会话模块（`src/session/`）
**职责：** 会话目录读写；列表摘要；创建/加载；追加消息；标题更新。  
**对外接口：** `SessionStore` 全套方法。  
**依赖：** 用户数据目录（如 `~/.mewcode/sessions/`）。  
**约束：** 落盘内容不含 `api_key`。

### 对话编排（`src/chat/`）
**职责：** 一轮用户发送的完整生命周期；聚合流式正文与思考摘要；驱动落盘；透传事件。  
**对外接口：** `ChatService.send`。  
**依赖：** `SessionStore`、`ChatProvider`、当前 `ProviderConfig`（含 thinking 开关）。

### TUI 模块（`src/tui/`）
**职责：**  
1) 启动屏：历史列表 + 新建；  
2) 对话屏：消息区、输入框、流式正文、思考折叠/摘要、告警与错误。  
**对外接口：** `startApp(deps)`。  
**依赖：** ChatService、SessionStore、LoadConfigResult.warnings。  
**技术选型：** Ink（React 终端 UI）。

## 模块交互

### 启动链路
1. CLI 启动 → `ConfigLoader.load()`
2. 若失败 → 打印中文错误并退出
3. 成功 → `ProviderFactory.create(active)` + `SessionStore` + `ChatService`
4. 将 `warnings` 与上述依赖交给 TUI → `startApp`
5. TUI 调用 `SessionStore.list()` 渲染历史；用户选中或新建

### 新建 / 恢复会话
- **新建：** `SessionStore.create()` → 进入空对话屏
- **恢复：** `SessionStore.get(id)` → 渲染已有 `messages` → 进入对话屏

### 发送一轮消息（主路径）
```
TUI(用户提交文本)
  → ChatService.send(sessionId, text)
      → SessionStore.appendMessage(user)
      → ChatProvider.streamChat(历史 messages + 配置)
          →（HTTP SSE）Anthropic / OpenAI
      ← StreamEvent 流（text_delta / thinking_* / error / done）
      → 聚合助手 content、thinkingSummary
      → SessionStore.appendMessage(assistant)（在 done 时）
  ← 同一 StreamEvent 流透传
TUI：text_delta 追加正文；thinking_* 更新折叠摘要；error 显示中文错误
```

### thinking 告警路径（F11）
- 配置加载阶段：若 `thinking: true` 且协议不支持 → `warnings` 含中文说明
- TUI 在对话屏展示该告警；发送仍走正常 `streamChat`（OpenAI 不启用思考参数）

### 错误路径（N4 / AC11）
- Provider 将 HTTP/网络/认证失败映射为 `StreamEvent{ type: "error", message: 中文 }`
- ChatService 在流式 `error` 时不写入助手成功消息
- TUI 展示错误，输入框可继续下一轮

### 依赖方向（无环）
```
CLI → TUI → ChatService → Provider / SessionStore
 CLI → ConfigLoader → ProviderFactory
 ChatService 不依赖 TUI；Provider 不依赖 Session/TUI
```

## 文件组织

```
my-ai-coding-agent/
├── package.json                 — 包名 mewcode、启动脚本、依赖
├── tsconfig.json                — TypeScript 编译配置
├── AGENTS.md
├── docs/01-tui-streaming-chat/
│   ├── spec.md
│   ├── plan.md
│   ├── task.md
│   └── checklist.md
├── .mewcode/
│   └── config.example.yaml      — 示例配置（无真实密钥）；默认 active=deepseek，model=deepseek-v4-flash
├── src/
│   ├── index.ts                 — 进程入口
│   ├── cli.ts                   — 组装依赖并启动 TUI
│   ├── config/
│   │   ├── types.ts
│   │   ├── paths.ts
│   │   ├── load.ts
│   │   └── validate.ts
│   ├── provider/
│   │   ├── types.ts
│   │   ├── factory.ts
│   │   ├── anthropic.ts
│   │   └── openai.ts
│   ├── session/
│   │   ├── types.ts
│   │   └── store.ts
│   ├── chat/
│   │   └── service.ts
│   └── tui/
│       ├── app.tsx
│       ├── session-picker.tsx
│       ├── chat-screen.tsx
│       ├── message-list.tsx
│       └── index.ts
└── README.md
```

运行时数据（不入库）：
- 项目配置：`./.mewcode/config.yaml`
- 用户配置：`~/.mewcode/config.yaml`
- 会话：`~/.mewcode/sessions/<id>.json`

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 语言与运行时 | TypeScript + Node.js（ESM） | 与 AGENTS.md / N1 一致 |
| 包管理 / 启动 | `package.json` bin + `tsx` 运行 | 开发期快速启动 |
| TUI | Ink + React | 适合流式状态更新 |
| YAML 解析 | `yaml` 包 | 标准、维护活跃 |
| HTTP / SSE | 原生 `fetch` + 流式 body 解析 | 减少重依赖；满足 N2 |
| Anthropic 协议 | Messages API + stream SSE；扩展思考 | 满足 F8/F10 |
| OpenAI 协议 | Chat Completions `stream: true` | 满足 F8；兼容 DeepSeek 等代理 |
| 开发默认模型 | DeepSeek `deepseek-v4-flash`（走 openai 协议） | 本轮联调/验收优先默认；降低对 Anthropic 密钥依赖 |
| 示例配置 | `active: deepseek` + DeepSeek `base_url` | 开箱即可按 DeepSeek 填写密钥验证 |
| Provider 扩展 | `protocol` → 工厂注册 | 满足 F9 |
| 配置路径 | 项目 `.mewcode/config.yaml` 优先，否则 `~/.mewcode/config.yaml` | 满足 F7 |
| 当前供应商 | YAML 顶层 `active` 指向某 `name` | 多供应商切换清晰 |
| 会话存储 | `~/.mewcode/sessions/*.json` | 满足 F4 |
| 思考 UI | 默认摘要/折叠，不全文刷屏 | 满足 F10 |
| 失败落盘 | `error` 不写入助手成功消息 | 避免污染多轮上下文 |
| 文案与注释 | 中文 | N6 |
| 测试策略 | 核心逻辑可单测；E2E 按 AGENTS.md 用 tmux；默认用 DeepSeek 验流式多轮 | 对齐 N5；Anthropic/thinking 有条件再验 |

## Spec 覆盖自检

| Spec | 归属 |
|------|------|
| F1 | CLI + TUI |
| F2 | ChatService + Provider + TUI |
| F3 | SessionStore + ChatService |
| F4 | SessionStore |
| F5 | TUI session-picker |
| F6/F7 | config/ |
| F8 | anthropic.ts + openai.ts |
| F9 | ChatProvider + factory |
| F10 | Anthropic + TUI message-list |
| F11 | validate warnings + TUI |
| N2 | SSE 流式 |
| N3 | 会话不存 api_key；示例无真实密钥 |
| N4 | error 事件 + CLI/TUI 中文错误 |
| N6 | 中文文案与注释 |
