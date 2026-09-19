# MewCode MCP 客户端 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/mcp/types.ts` | 配置、JSON-RPC、传输、远端工具类型 |
| 新建 | `src/mcp/config.ts` | 合并、校验、变量展开 |
| 新建 | `src/mcp/jsonrpc.ts` | 编号配对 |
| 新建 | `src/mcp/stdio-transport.ts` | 子进程按行收发 |
| 新建 | `src/mcp/http-transport.ts` | POST、会话标识、JSON 或 SSE |
| 新建 | `src/mcp/session.ts` | 握手、分页列出、调用 |
| 新建 | `src/mcp/register.ts` | 并行连接、包装工具、统一关闭 |
| 修改 | `src/permission/subject.ts` | 带 `__` 的工具用稳定 JSON |
| 修改 | `src/permission/load.ts` | 规则接受这种注册名 |
| 修改 | `src/cli.ts` | 启动连接，退出关闭 |
| 修改 | `.mewcode/config.example.yaml` | 注释形式的 `mcp_servers` 示例 |

## T1: MCP 类型

**文件：** `src/mcp/types.ts`  
**依赖：** 无  
**步骤：**
1. 定义 `McpServerConfig` 两种形态：`stdio` 含 `name`、`command`、`args`、`env`；`http` 含 `name`、`url`、`headers`
2. 定义 `McpLoadResult`：`servers` 与 `warnings`
3. 定义 JSON-RPC 请求、通知、成功回包、失败回包。请求和成功回包的 `id` 是 `number`
4. 定义 `McpTransport`：`send`、`onMessage`、`close`
5. 定义 `McpListedTool`：`name`、`description`、`inputSchema`
6. 导出协议版本常量 `"2025-11-25"` 和握手上限 `15_000`

**验证：** `npm run typecheck` 不因本文件报错

## T2: 配置合并与变量展开

**文件：** `src/mcp/config.ts`  
**依赖：** T1  
**步骤：**
1. 用现有 `userConfigPath` 和 `projectConfigPath` 读两份 YAML，只取 `mcp_servers`。文件不存在、没有该字段、或该字段不是对象，视为空映射
2. 某一份解析失败时，把中文警告加入结果，不抛出。不要改 `loadConfig`
3. 先放入用户级条目，再用项目级同名键整段替换
4. 服务器名必须匹配 `^[A-Za-z0-9]+(?:[_-][A-Za-z0-9]+)*$`。否则跳过并警告
5. `type` 不是 `stdio` 或 `http`，或缺少 `command` / `url`，跳过并警告。`args` 缺省 `[]`，`env` 和 `headers` 缺省 `{}`。`args` 必须是字符串数组
6. 用正则找出 `${变量名}`，只扫描 `env` 和 `headers` 的值。变量不在 `process.env` 时跳过整个 Server，警告里只出现服务器名和变量名。命令、参数、地址原样保留
7. 展开成功的值写入返回的配置，警告文本里不包含这些值

**验证：** 临时目录放用户级和项目级两份 YAML。同名 Server 应只剩项目级字段。`env` 里的 `${PATH}` 能展开，命令里的 `${PATH}` 保持原文。不存在的变量使该 Server 被跳过，且 `warnings` 不含真实环境值。脚本跑完删除临时目录

## T3: JSON-RPC 配对

**文件：** `src/mcp/jsonrpc.ts`  
**依赖：** T1  
**步骤：**
1. `JsonRpcPeer` 接收一个 `McpTransport`。编号从 1 递增
2. `request` 先登记等待者，再 `send`。成功回包 resolve `result`，失败回包 reject 错误信息。超时后拒绝这次等待并删掉登记，不抛到进程外的未处理拒绝
3. `notify` 只 `send`，不等待
4. `onMessage` 收到带 `method` 和 `id` 的消息时，`send` 一条 `id` 相同、`error.code` 为 `-32601` 的失败回包
5. 编号对不上的回包忽略。`close` 拒绝所有尚未完成的等待，并关闭传输

**验证：** 用内存传输把两条 `request` 的回包按相反顺序送回，断言结果不串线。再送一条带 `method` 和 `id` 的服务端请求，断言发出的回包代码是 `-32601`。脚本跑完删除

## T4: 本地传输

**文件：** `src/mcp/stdio-transport.ts`  
**依赖：** T1  
**步骤：**
1. `createStdioTransport(config, workspaceRoot)` 用 `command` 和 `args` 启动子进程。工作目录是 `workspaceRoot`。环境是 `process.env` 加上 `config.env`，同名以配置为准
2. 标准输入每条消息写一行 JSON。标准输出按行解析，空行跳过，解析失败的行忽略。解析成功后调用 `onMessage`
3. 标准错误读掉并丢弃，不触发 `onMessage`，也不因此 `close`
4. `close` 结束子进程。重复调用不抛错

**验证：** 用一个会把标准输入原文写回标准输出、并向标准错误写一行字的命令。发送一条 JSON 后能在 `onMessage` 收到同一对象。进程不因标准错误退出。Windows 上可用 `node -e` 做这个回显。脚本跑完删除，并关掉子进程

## T5: 远程传输

**文件：** `src/mcp/http-transport.ts`  
**依赖：** T1  
**步骤：**
1. `createHttpTransport(config)` 的 `send` 向 `url` POST 单条消息。带上 `config.headers`，并设置 `Accept: application/json, text/event-stream` 和 `Content-Type: application/json`
2. 响应头有 `Mcp-Session-Id` 时保存。之后每次请求都带这个头
3. 状态码 202，或没有正文的成功响应，直接结束，不调用 `onMessage`
4. `Content-Type` 含 `application/json` 时解析正文并 `onMessage`。含 `text/event-stream` 时按 SSE 事件读取，`data` 是 JSON 就 `onMessage`，直到出现与本次请求 `id` 相同的回包或流结束
5. `close` 在已有会话标识时，向同一地址发送 `DELETE` 并带上该标识。之后 `send` 直接失败。网络错误变成拒绝，不抛出进程

**验证：** 用本地 `http` 服务做两次断言。一次返回 JSON 回包。一次返回两行 SSE，第二行的 `id` 与请求相同，断言只把这条交给 `onMessage`，并且后续请求带上第一次响应里的 `Mcp-Session-Id`。脚本结束时关掉服务

## T6: 会话握手与调用

**文件：** `src/mcp/session.ts`  
**依赖：** T3  
**步骤：**
1. `openMcpSession` 在 `handshakeMs` 内依次完成 `initialize`、`notifications/initialized`、`tools/list`
2. `initialize` 的 `protocolVersion` 为 `2025-11-25`，`capabilities` 为 `{}`，`clientInfo.name` 为 `MewCode`。回包里的 `protocolVersion` 不是这个值时，关闭传输并失败
3. `tools/list` 只要结果里有 `nextCursor` 就带上 `cursor` 再请求，直到没有下一页。工具缺 `inputSchema` 时用 `{ type: "object" }`，缺 `description` 时用空字符串
4. `callTool(name, args, timeoutMs)` 发送 `tools/call`。只拼接 `content` 中 `type` 为 `text` 的 `text`。`isError` 为真时返回失败。没有文本时内容为「远端没有返回文本」
5. 超时、传输失败或会话已关闭时返回失败中文说明，不重新连接

**验证：** 内存传输模拟两页 `tools/list` 和一次 `tools/call`。断言工具数是两页之和，文本结果正确，`isError: true` 时 `ok` 为假。脚本跑完删除

## T7: 注册进工具中心

**文件：** `src/mcp/register.ts`  
**依赖：** T2、T4、T5、T6  
**步骤：**
1. `connectMcpServers(workspaceRoot, registry)` 先 `loadMcpServers`，再并行连接。每个 Server 用自己的 15 秒上限
2. 按 `type` 创建对应传输，成功后 `openMcpSession`
3. 每个工具注册为现有 `Tool`：名字 `服务器名__工具原名`，`sideEffect: true`，`execute` 调用该会话的 `callTool`，超时用 `ctx.timeoutMs`
4. 原名为空，或注册名与 `read_file`、`write_file`、`edit_file`、`run_command`、`glob_files`、`grep_search` 之一相同，则跳过并警告
5. 单个 Server 失败只追加中文警告。返回的 `close` 关闭所有已打开的会话，重复调用不抛错

**验证：** 一个内存或子进程假 Server 能注册出预期名字。另一个会握手失败的配置不影响前者。`registry.get` 能拿到前者，拿不到后者。脚本跑完调用 `close`

## T8: 权限规则与匹配对象

**文件：** `src/permission/subject.ts`、`src/permission/load.ts`  
**依赖：** 无  
**步骤：**
1. 在 `permissionSubject` 中，六个内置工具的分支保持不变。名字包含 `__` 且两侧都非空时，返回稳定 JSON
2. 稳定 JSON 对对象键递归按字典序排序，数组顺序不变。参数缺失、不是对象时返回 `"{}"`
3. `load.ts` 的工具名校验在六个名字之外，接受同样的 `__` 注册名。其他名字仍跳过并警告
4. 不改黑名单和沙箱的进入条件

**验证：** `permissionSubject("fs__echo", { b: 1, a: { d: 1, c: 2 } })` 与键顺序相反的对象结果相同。加载一份含 `fs__echo` 和 `not-a-tool` 的规则，前者保留，后者进入警告。脚本跑完删除临时文件

## T9: 启动接入与示例配置

**文件：** `src/cli.ts`、`.mewcode/config.example.yaml`  
**依赖：** T7  
**步骤：**
1. 六个内置工具注册之后调用 `connectMcpServers`。把它的 `warnings` 并入传给 `startApp` 的警告
2. 用一个只执行一次的关闭函数挂到 `beforeExit`。收到 `SIGINT` 或 `SIGTERM` 时先关闭再退出，避免关两次
3. 供应商配置加载失败时仍直接返回，不连接 MCP
4. 在示例配置末尾加一段注释掉的 `mcp_servers`，分别示范 `stdio` 和 `http`。不要写成会在复制后立即连接的有效配置

**验证：** `npm run typecheck` 通过。示例文件里能看到 `mcp_servers`，且没有未注释的 `mcp_servers:` 键

## T10: 总类型检查

**文件：** 无新文件  
**依赖：** T1–T9  
**步骤：**
1. 运行 `npm run typecheck`
2. 修到退出码为 0。不提交

**验证：** 命令退出码为 0

## 执行顺序

```
T1 → T2 → T7 → T9 → T10
  ↘ T3 → T4 ↗
       ↘ T5 ↗
       → T6 ↗
T8 ──────────────→ T10
```

T2、T3、T8 在 T1 之后彼此无依赖。T4 和 T5 都只依赖 T3。T7 要等 T2、T4、T5、T6。T10 必须最后。
