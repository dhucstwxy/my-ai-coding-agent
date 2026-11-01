# MewCode Agent API

本地 Coding Agent 的 HTTP 外壳。FastAPI 进程拉起 `mewcode serve-worker`，由它调用已有的无头 Agent（`runHeadless`）。交互式 CLI 不受影响。

## 行为

- 工具权限为自动放行，与 `mewcode run` 相同。
- 默认只监听 `127.0.0.1`。监听 `0.0.0.0` 或 `::` 时必须设置 `MEWCODE_SERVER_TOKEN`，否则进程退出。
- 全局串行：一个任务在跑时，新任务排队。
- 会话文件在 `<workspace>/.mewcode/api-sessions/`，和 TUI 会话分开。
- 配置查找与 CLI 相同：工作区 `.mewcode/config.yaml`，否则 `~/.mewcode/config.yaml`。密钥可用 `MEWCODE_API_KEY`。

## 启动

需要 Node.js >= 20、Python >= 3.11，并已在仓库根目录执行过 `npm install`。

```powershell
cd server
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
cd ..
$env:MEWCODE_API_KEY = "sk-xxx"
.\server\.venv\Scripts\python server\mewcode_api\__main__.py
```

默认地址：<http://127.0.0.1:8787> ，聊天页：<http://127.0.0.1:8787/chat> ，交互文档：<http://127.0.0.1:8787/docs>。依赖已装在当前 Python 里时，也可以在仓库根目录执行 `npm run serve`。

| 变量 | 作用 |
| --- | --- |
| `MEWCODE_SERVER_HOST` | 监听地址，默认 `127.0.0.1`。设为 `0.0.0.0` 或 `::` 时必须同时设置令牌 |
| `MEWCODE_SERVER_PORT` | 端口，默认 `8787` |
| `MEWCODE_SERVER_TOKEN` | 设置后，`/v1/*` 需要 `Authorization: Bearer <token>` |
| `MEWCODE_SERVER_DATA` | 运行记录目录，默认 `~/.mewcode/server` |
| `MEWCODE_MAX_QUEUED` | 未结束任务上限，默认 20，超出返回 429 |
| `MEWCODE_WORKSPACE` | 请求没写 `workspace` 时使用的目录 |
| `MEWCODE_ALLOWED_ROOTS` | 用系统路径分隔符列出允许的根目录；不设则不限制 |
| `MEWCODE_WORKER_CMD` | JSON 字符串数组，覆盖 worker 启动命令 |

## 接口

`POST /v1/runs/wait` 会一直等到结束，HTTP 200，正文里的 `status` 区分成功、失败和取消。成功时 `report.finalMessage` 是回复。

```powershell
Invoke-RestMethod http://127.0.0.1:8787/v1/runs/wait -Method Post -ContentType "application/json" -Body (@{
  prompt = "只回复：pong"
  workspace = (Get-Location).Path
} | ConvertTo-Json)
```

`POST /v1/runs` 立即返回 `202`，适合长时间任务。请求体：

```json
{
  "prompt": "给 utils.ts 加上空值检查",
  "workspace": "D:/repo",
  "sessionId": "可选，继续上一轮",
  "timeoutMs": 600000
}
```

返回 `runId`、`status`、`position`。请求头 `Idempotency-Key` 在 24 小时内相同且 prompt 相同时返回同一次运行；prompt 不同则 409。

`GET /v1/runs/{runId}` 查看状态。跑的过程中 `partialText` 是已经生成的正文；结束后 `report` 与无头模式的 `result.json` 相同。记录写在 `MEWCODE_SERVER_DATA/runs/`，重启后仍可查询。

`GET /v1/runs/{runId}/events` 是 SSE。事件名：

- `status`：开始执行
- `text`：正文增量，`data.delta`
- `tool`：工具开始或结束，含 `name`、`phase`、`summary`
- `agent`：原始 Agent 事件
- `done`：终态，含 `text`、`sessionId`、`status`

`POST /v1/runs/{runId}/cancel` 取消排队中或正在跑的任务。取消会先落盘，重启不会把它再跑起来。

`GET /chat` 是一个单页。它用 `fetch` 读 SSE，因此可以带上 Bearer 令牌。`GET /health` 和 `GET /ready` 不要求令牌。

`GET /health` 只表示进程还在，执行器或任务库不可用时仍为 200。`GET /ready` 在执行器可用且任务库能打开时才为 200，否则为 503。列出对话和查询已有任务不看就绪。

多轮：把上一轮 `report.sessionId` 作为下一次的 `sessionId`，并且使用同一个 `workspace`。

## 重启后续跑

服务启动时会载入未结束的任务。仍在排队的会继续排。上次进程停在 `running` 且没有取消标记的，用同一个 `runId` 再跑，最多恢复 2 次，再失败就标成 `failed`。

如果用户消息已经写入会话（收到过 Agent 事件），续跑不会把同一句 prompt 再追加一遍。会话原文仍在 `<workspace>/.mewcode/api-sessions/`。

Worker 起不来或任务库打不开时，`/health` 仍为 200，`/ready` 为 503。提交接口返回 503，后台会重试拉起执行器。运行中的 worker 若反复超时，重启次数用尽后也不再拉起。列出对话和查询已有任务保持可用。

## 日志

标准输出是一行一个 JSON。一次任务的提交、开始、结束、失败带这些字段：

| 字段 | 含义 |
| --- | --- |
| `event` | `task.submit`、`task.start`、`task.end`、`task.fail` |
| `runId` | 任务号 |
| `sessionId` | 会话号。提交时如果还没有，就是 `null` |
| `status` | `queued`、`running`、`completed`、`failed`、`cancelled` |
| `durationMs` | 从任务创建到这条日志的毫秒数。结束和失败用结束时间 |

取消记为 `task.end`，`status` 为 `cancelled`。失败记为 `task.fail`。

## Docker

HTTP 镜像和终端镜像是两个构建目标。HTTP 镜像里有 Python 接口和编译后的 Node 执行器。容器默认监听所有网卡，因此必须带访问令牌。

```powershell
docker build --target server -t mewcode:server .
docker run --rm -p 8787:8787 `
  -e MEWCODE_SERVER_TOKEN="change-me" `
  -e MEWCODE_API_KEY="sk-xxx" `
  -v mewcode-data:/var/lib/mewcode `
  -v "${PWD}:/workspace" `
  mewcode:server
```

`/var/lib/mewcode` 是任务库。`/workspace` 是默认工作区。未设置令牌时容器会退出，并提示设置 `MEWCODE_SERVER_TOKEN`。终端镜像仍用默认目标：`docker build -t mewcode:local .`。
