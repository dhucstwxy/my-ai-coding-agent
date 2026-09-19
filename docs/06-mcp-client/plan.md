# MewCode MCP 客户端 Plan

## 架构概览

在现有「读配置 → 建工具中心 → 启动对话」之前，加一层 MCP 接入。供应商配置的读取方式不变。只额外合并两份配置里的 Server 列表，连上之后把远端工具注册进现有工具中心。权限闸门和计划模式不用新开一条路。

| 组件 | 职责 |
|------|------|
| 配置合并 | 只读两份配置里的 `mcp_servers`。用户级打底，同名键被项目级整段覆盖。缺段或为空就当没有 Server |
| 变量展开 | 只展开 `env` 和 `headers` 的值。某个 `${变量名}` 不存在，则整个 Server 不连接，警告里只写变量名 |
| 消息会话 | 按 JSON-RPC 2.0 发请求。编号唯一，回包按编号交回等待方。通知不等待。对不上的编号丢掉，不让进程退出 |
| 本地传输 | 一个 Server 一个子进程。标准输入输出按行收发。标准错误只丢弃，不参与配对，也不算连接失败 |
| 远程传输 | 向配置里的地址 POST。`Accept` 同时接受 JSON 和 SSE。初始化响应若带回会话标识，后续请求都带上。通知得到 202 即算送出。结果若是 SSE，读到与本次编号对应的那一条为止 |
| 连接过程 | 每个 Server 独立连接，互不等待。顺序固定：`initialize`、`notifications/initialized`、分页 `tools/list`。协议版本只接受 `2025-11-25`，谈不拢就关掉这个 Server。握手只声明客户端身份，不声明资源、提示词、采样 |
| 工具包装 | 注册名是 `服务器名__工具原名`。说明和参数结构照搬远端。一律标成有副作用。与六个内置名字相同则跳过并警告 |
| 生命周期 | 连接进程内缓存。退出时关闭子进程，远程则删除会话。中途断开不重连。之后对该 Server 的调用直接失败 |
| 权限与计划模式 | 计划模式的只读名单不变，因此这些工具不会出现。执行前仍走现有闸门。匹配对象改成这次参数的稳定 JSON，键顺序不影响全等。黑名单和路径沙箱仍只作用于原来的命令和路径工具 |

判断顺序：

```
启动
  → 合并 mcp_servers
  → 逐个展开变量、建立传输
  → 握手并列出工具
  → 包成现有工具并注册
  → 进入对话
模型调用
  → 计划模式先过滤（远端工具不在名单里）
  → 权限闸门（全名 + 参数 JSON）
  → 允许后 tools/call
  → 文本结果或结构化失败回到循环
```

某个 Server 失败只产生警告，不取消已经注册的其他工具，也不阻止进入对话。服务端如果在响应里反过来发请求，回一条「方法不支持」，避免对方一直等。不为此打开长期的 GET 监听。

## 核心数据结构

### 配置

两份现有配置里增加可选字段 `mcp_servers`。键是服务器名，值是下面两种之一。

```yaml
mcp_servers:
  fs:
    type: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "."]
    env:
      TOKEN: ${TOKEN}
  remote:
    type: http
    url: https://example.com/mcp
    headers:
      Authorization: Bearer ${TOKEN}
```

展开并校验通过后的内存形态：

- `name: string`。必须匹配 `^[A-Za-z0-9]+(?:[_-][A-Za-z0-9]+)*$`，因此不会含 `__`
- `type: "stdio"` 时还有 `command: string`、`args: string[]`、`env: Record<string, string>`。`args` 缺省为 `[]`，`env` 缺省为 `{}`
- `type: "http"` 时还有 `url: string`、`headers: Record<string, string>`。`headers` 缺省为 `{}`

`McpLoadResult` 是 `{ servers: McpServerConfig[]; warnings: string[] }`。不合法的条目不进入 `servers`。

### JSON-RPC

- 请求：`{ jsonrpc: "2.0"; id: number; method: string; params?: unknown }`
- 通知：没有 `id`，其余相同
- 成功回包：`{ jsonrpc: "2.0"; id: number; result: unknown }`
- 失败回包：`{ jsonrpc: "2.0"; id: number; error: { code: number; message: string } }`

编号从 1 递增，每个 Server 自己计数。

### 传输

`McpTransport`：

- `send(message: JsonRpcMessage): Promise<void>`
- `onMessage(handler: (message: JsonRpcMessage) => void): void`
- `close(): Promise<void>`

本地传输额外记录子进程。远程传输额外记录 `sessionId: string | null`，来自响应头 `Mcp-Session-Id`。

### 消息会话

`JsonRpcPeer` 建在一个传输之上。

- `request(method, params, timeoutMs): Promise<unknown>`。超时或失败回包时拒绝，不抛到进程外
- `notify(method, params?): Promise<void>`。不等待回包
- 收到带 `id` 且带 `method` 的服务端请求时，回 `{ code: -32601, message: "Method not found" }`
- `close(): Promise<void>`

### 远端工具

`McpListedTool`：`name`、`description`、`inputSchema`。`inputSchema` 缺省为 `{ type: "object" }`。

注册到工具中心的名字是 `` `${serverName}__${tool.name}` ``。`sideEffect` 固定为 `true`。

`tools/call` 的结果只拼接 `content` 里 `type === "text"` 的 `text`。`isError: true` 时包装成 `ToolResult.ok = false`。没有任何文本时，`content` 为「远端没有返回文本」。

### 权限匹配对象

六个内置工具的取法不变。名字里含 `__` 的工具，匹配对象是参数的稳定 JSON：对象的键按字典序递归排序，数组顺序保持不变。没有参数或参数不是对象时，用 `{}`。因此 `{"b":1,"a":2}` 和 `{"a":2,"b":1}` 是同一条精确规则。

权限文件里的 `tool` 除了原来的六个名字，还接受这种带 `__` 的注册名。两侧都必须非空。其他名字仍然跳过。

### 常量

- 协议版本只接受 `"2025-11-25"`
- 握手加列出工具的上限是 15 秒，每个 Server 单独计时
- 单次 `tools/call` 使用现有的 `ToolContext.timeoutMs`

## 模块设计

### 类型（`src/mcp/types.ts`）

**职责：** 定义 `McpServerConfig`、`McpLoadResult`、JSON-RPC 四种消息、`McpListedTool`、`McpTransport`。  
**对外接口：** 上述类型。  
**依赖：** 无。  
**满足：** F2、F6、F7。

### 配置合并（`src/mcp/config.ts`）

**职责：** 分别读取用户级和项目级现有配置，只取出 `mcp_servers`。用户级打底，同名键用项目级整条替换。校验服务器名、传输种类和必填项。只对 `env` 和 `headers` 的值做 `${变量名}` 替换；命令、参数、地址保持原文。变量不存在或条目不合法时跳过该 Server，写入中文 `warnings`，警告中不包含展开后的值。文件不存在或没有这段配置，视为空列表。某一份 YAML 解析失败时，只放弃这一份里的 Server，不影响供应商配置的原有读取。  
**对外接口：** `loadMcpServers(workspaceRoot: string): McpLoadResult`。  
**依赖：** 现有配置路径、YAML 解析、`process.env`。  
**满足：** F1、F2、F3、F4、F5。

### 消息会话（`src/mcp/jsonrpc.ts`）

**职责：** 在一个 `McpTransport` 上实现编号配对。`request` 登记编号并等待对应成功或失败回包，超时后拒绝这次等待。`notify` 只发送。收到服务端请求时回 `-32601`。对不上的编号忽略。  
**对外接口：** `JsonRpcPeer.request`、`notify`、`close`。  
**依赖：** `McpTransport`。  
**满足：** F7、N5。

### 本地传输（`src/mcp/stdio-transport.ts`）

**职责：** 用 `command`、`args` 和已经展开的 `env` 启动子进程，工作目录为当前项目。子进程环境继承当前进程环境，配置里的同名项覆盖。标准输入输出按行解析 JSON。标准错误直接丢弃。`close` 结束进程。  
**对外接口：** `createStdioTransport(config, workspaceRoot): McpTransport`。  
**依赖：** 子进程。  
**满足：** F6、N6。

### 远程传输（`src/mcp/http-transport.ts`）

**职责：** 向 `url` POST 单条 JSON-RPC。请求带已展开的 `headers`，以及同时接受 JSON 和 SSE 的 `Accept`。响应头有 `Mcp-Session-Id` 时保存，之后每次都带上。通知或无回包的响应以 202 为成功。`Content-Type` 是 JSON 时直接解析；是 SSE 时读取事件，直到出现与本次编号对应的回包。`close` 在有会话标识时发送删除会话的请求，然后不再发送。  
**对外接口：** `createHttpTransport(config): McpTransport`。  
**依赖：** 全局 `fetch`。  
**满足：** F6、AC8。

### 会话（`src/mcp/session.ts`）

**职责：** 一个 Server 一条会话。15 秒内完成 `initialize`、`notifications/initialized` 和全部 `tools/list` 页。`initialize` 的协议版本只写 `2025-11-25`，能力对象为空。服务端回的版本不是这个值，则失败并关闭。`callTool` 发 `tools/call`，超时用调用方传入的毫秒数。失败、超时或传输已关闭时返回失败文本，不重连。  
**对外接口：** `openMcpSession(config, transport, handshakeMs): Promise<McpSession>`。`McpSession` 有 `tools`、`callTool`、`close`。  
**依赖：** `JsonRpcPeer`。  
**满足：** F8、F13、N4。

### 注册（`src/mcp/register.ts`）

**职责：** 启动时并行连接每个 Server，每个自己计时 15 秒。成功则把每个远端工具包成现有 `Tool`：名字为 `服务器名__工具原名`，`sideEffect: true`，`execute` 调用 `callTool`。与六个内置名字相同，或原名为空，则跳过并警告。失败的 Server 只加警告。返回一个 `close`，供进程退出时关闭全部会话。  
**对外接口：** `connectMcpServers(workspaceRoot, registry): Promise<{ warnings: string[]; close: () => Promise<void> }>`。  
**依赖：** 配置合并、两种传输、会话、工具中心。  
**满足：** F1、F9、F10、F14。

### 权限接入（`src/permission/subject.ts`、`src/permission/load.ts`）

**职责：** 六个内置工具的匹配对象不变。名字含 `__` 时，匹配对象改为参数的稳定 JSON；非对象或空参数用 `{}`。规则加载除六个名字外，接受含 `__` 且两侧都非空的注册名。黑名单和沙箱的入口条件不变，因此不会套到这些工具上。  
**对外接口：** 现有 `permissionSubject`、`loadPermissionRules`。  
**依赖：** 无新模块。  
**满足：** F11、F12。

### 启动接入（`src/cli.ts`）

**职责：** 建好六个内置工具之后调用 `connectMcpServers`，把警告并入现有启动警告。进程即将退出时调用 `close`。不改计划模式的只读名单，远端工具因此不会在计划模式出现。  
**对外接口：** 现有 `runCli`。  
**依赖：** 注册模块、现有工具中心。  
**满足：** F10、F14、N1。

计划模式过滤和调度器不用改。副作用标记已经会让这些工具串行；只读名单里没有它们，计划模式就不会交给模型。

## 模块交互

### 启动

1. CLI 仍按现在的方式加载供应商配置。失败则直接退出，不连 MCP。
2. 建好六个内置工具后，调用 `connectMcpServers`。
3. 配置模块读取两份 `mcp_servers`，合并、校验、展开变量，得到 Server 列表和警告。
4. 对每个 Server 并行连接，各自 15 秒：stdio 或 HTTP 传输，再 `openMcpSession`。会话内部顺序是 `initialize`、`notifications/initialized`、按 `nextCursor` 取完 `tools/list`。
5. 成功的工具注册进现有工具中心。失败的 Server 只留下警告，已注册的工具保留。
6. 警告并入现有启动警告。然后进入对话。

### 一次调用

```
执行模式把全部已注册工具交给模型
计划模式仍只留三个只读内置工具
模型发出 服务器名__工具原名
  → 调度器看到 sideEffect，串行执行
  → 闸门取稳定 JSON 作为匹配对象
  → 黑名单和沙箱不进入
  → 规则或档位允许后，包装工具调用对应会话的 callTool
  → 文本或失败说明写入工具结果，循环继续
```

### 退出

进程退出前调用注册模块返回的 `close`。每条会话先关消息通道，再关传输。本地传输结束子进程。远程传输在有 `Mcp-Session-Id` 时删除会话。

### 依赖方向

```
CLI → connectMcpServers → 配置合并 / 会话 / 工具中心
会话 → JsonRpcPeer → McpTransport
权限匹配对象不依赖 MCP 会话
传输不依赖工具中心和权限
```

## 文件组织

```
docs/06-mcp-client/
├── spec.md
├── plan.md
├── task.md
└── checklist.md

src/mcp/
├── types.ts              — 配置、JSON-RPC、传输、远端工具类型
├── config.ts             — 两份 mcp_servers 合并、校验、变量展开
├── jsonrpc.ts            — 编号配对与服务端请求拒绝
├── stdio-transport.ts    — 子进程按行收发
├── http-transport.ts     — POST、会话标识、JSON 或 SSE
├── session.ts            — 握手、分页列出、tools/call
└── register.ts           — 逐个连接、包装成 Tool、统一关闭

src/permission/subject.ts — 带 __ 的工具用稳定 JSON
src/permission/load.ts    — 规则里的 tool 接受这种注册名
src/cli.ts                — 启动时连接，退出时关闭
.mewcode/config.example.yaml — 补一段 mcp_servers 示例
```

计划模式和调度器没有新文件。

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 实现方式 | 自写最小客户端，不引入 MCP SDK | 只做工具这三步，失败隔离和权限接入自己能控 |
| 协议版本 | 只接受 `2025-11-25` | 和当前规范一致。谈不拢就放弃该 Server，不维护多套消息 |
| 配置位置 | 仍写在现有两份配置的 `mcp_servers` | 不另起文件。供应商配置的读取函数不动 |
| 合并方式 | 同名键整段替换，不拼字段 | 避免项目级只写了 `url`、却留下用户级的旧请求头 |
| 变量展开 | 只处理 `env` 和 `headers` 的值。缺失则跳过该 Server | 满足不把空密钥发出去。命令和地址保持原文 |
| 警告内容 | 只写服务器名、变量名、失败原因 | 避免把已经展开的密钥打进界面 |
| 子进程环境 | 继承当前进程环境，配置里的同名项覆盖 | 普通命令能找到可执行文件，密钥仍可由配置注入 |
| 子进程目录 | 当前项目目录 | 相对路径和 Server 自己的文件访问以项目为基准 |
| 本地分帧 | 一行一条 JSON。标准错误丢弃 | 这是 stdio 传输的规定。日志不能拆开协议消息 |
| 远程传输 | 只 POST。`Accept` 同时写 JSON 和 SSE。保存并回传 `Mcp-Session-Id` | 规范要求的最小客户端。长期 GET 只为接收服务端推送，这一章用不到 |
| 服务端反向请求 | 回 `-32601` | 不实现采样。不回复会让对方一直等 |
| 连接时机 | 启动时并行连接，每个 Server 自己 15 秒 | 一个卡住不会把其他 Server 的 15 秒串起来，也不会永远不进对话 |
| 调用超时 | 用现有工具超时 | 不再发明第二套超时 |
| 副作用 | 全部 `sideEffect: true` | 看不出只读。调度器因此串行，不用改调度代码 |
| 计划模式 | 不把这些名字加进只读名单 | 名单不变，它们自然不会出现 |
| 权限对象 | 稳定 JSON，对象键递归排序 | 键顺序不同仍能命中同一条精确规则 |
| 黑名单和沙箱 | 判断条件不改 | 只有命令工具和路径工具会走进去 |
| 调用结果 | 只拼接文本块。`isError` 变成工具失败 | 模型侧只收文本。图片等内容这一章不传 |
| 断开 | 不重连。退出时关进程，有会话标识则删除远程会话 | 明确不做健康检查和自动重连 |

## Spec 覆盖

| 需求 | 归属 |
|------|------|
| F1、F9、F10、F14 | `register.ts`、`cli.ts` |
| F2、F3、F4、F5 | `config.ts` |
| F6、N6 | 两种传输 |
| F7、N5 | `jsonrpc.ts` |
| F8、F13、N4 | `session.ts` |
| F11、F12 | `permission/subject.ts`、`permission/load.ts` |
| N1、N2、N3、N7 | 启动警告沿用现有界面，文案用中文，且不打印展开值 |
| N8 | 本地假 Server 可覆盖列出、调用、一个失败不挡另一个、缺变量不连接 |
