# 服务端长驻会话 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
| --- | --- | --- |
| 新建 | `server/mewcode_api/session_catalog.py` | 对话目录：空文件、列出、打开、标签和排序 |
| 修改 | `server/mewcode_api/models.py` | 对话摘要、消息、创建请求、发送请求和发送结果 |
| 修改 | `server/mewcode_api/run_manager.py` | `submit_for_session`、`busy_session_ids` |
| 修改 | `server/mewcode_api/main.py` | 四个对话路由 |
| 修改 | `server/mewcode_api/static/chat.html` | 对话列表、新建、打开、发送和事件流 |
| 修改 | `server/tests/fake_worker.py` | 测试替身把用户消息和助手回复写入已有会话文件 |
| 修改 | `server/tests/test_api.py` | 对话接口、忙闲、重启后列出、一次性任务回归 |

`src/` 不改。

## T1: 请求与响应模型

**文件：** `server/mewcode_api/models.py`  
**依赖：** 无  
**步骤：**
1. 增加 `ConversationSummary`：`sessionId`、`workspace`、`label`、`busy`、`createdAt`、`updatedAt`。
2. 增加 `ConversationMessage`：`role` 只能是 `user` 或 `assistant`，加上 `content`、`createdAt`。
3. 增加 `ConversationDetail`，包含摘要的全部字段，再加 `messages`。
4. 增加 `CreateConversationBody`，只有可选 `workspace`。
5. 增加 `SendMessageBody`：`prompt` 规则与 `CreateRunBody` 相同（去掉空白后不能为空，最长 200000），另加可选 `workspace`。
6. 增加 `SendMessageResponse`：`sessionId`、`runId`、`status`、`workspace`、`position`。

**验证：** 在 `server` 目录执行 `python -c "from mewcode_api.models import ConversationDetail, SendMessageBody"`，导入成功。

## T2: 创建空对话

**文件：** `server/mewcode_api/session_catalog.py`  
**依赖：** T1  
**步骤：**
1. 定义 `SessionCatalog`。会话目录为 `<workspace>/.mewcode/api-sessions`。
2. `create(workspace)` 生成 `年月日-时分秒-6位十六进制` 标识，使用本地时间，规则与现有 `check_session_id` 相容。文件已存在则换一个，最多 5 次，仍碰撞就用中文原因失败。
3. 用临时文件写入一行后替换目标文件。内容为 `type=session`、该标识、`title` 为「新会话」、`createdAt` 为 UTC 的 `Z` 时间。
4. 返回摘要：`label` 为「新对话」，`busy` 为假，`workspace` 为绝对路径，`updatedAt` 用文件修改时间。

**验证：** 临时目录调用 `create`，磁盘上只有这一行 JSON，且 `label` 为「新对话」。脚本用完即删。

## T3: 列出和打开

**文件：** `server/mewcode_api/session_catalog.py`  
**依赖：** T2  
**步骤：**
1. `list(workspace, busy_ids)` 只读该目录下的 `*.jsonl`。按 `updatedAt` 从新到旧排。`updatedAt` 取文件修改时间与最后一条消息 `createdAt` 中较晚者。
2. `label`：第一句 `user` 消息把连续空白折成一个空格，最多 40 个字符，超出加省略号；没有用户消息则为「新对话」。`busy` 看标识是否在 `busy_ids` 里。
3. `get(workspace, session_id)` 做同样的标识校验。不合法返回 400，文件不存在返回 404，中文原因。`busy` 固定为假，由路由随后覆盖。
4. `messages` 只保留 `user` 和 `assistant`，按文件顺序，带上 `content` 和 `createdAt`。损坏的行跳过。不读取终端目录 `.mewcode/sessions`。

**验证：** 临时目录放一个空文件头、一个含 user/assistant/tool 的文件。列表顺序是最近活动在前；打开结果没有 tool 消息；错误标识和缺失文件分别得到 400 和 404。

## T4: 按对话提交一轮

**文件：** `server/mewcode_api/run_manager.py`  
**依赖：** 无  
**步骤：**
1. `busy_session_ids()` 收集状态不是 `completed`、`failed`、`cancelled` 且带有会话标识的任务。
2. `submit_for_session(workspace, session_id, prompt)` 在同一次调用里依次检查：worker 不可用则 503；该标识已在忙集合里则 409，详情「这段对话正忙」；未结束任务达到上限则 429。
3. 通过后复用现有 `RunState` 入队。会话目录固定为 `<workspace>/.mewcode/api-sessions`，并从入队起写上 `session_id`。不接受幂等键。
4. 现有 `submit` 的参数、幂等和恢复逻辑不改。

**验证：** 在 `server` 目录执行 `python -c "from mewcode_api.run_manager import RunManager; assert callable(RunManager.submit_for_session) and callable(RunManager.busy_session_ids)"`。再执行 `python -m unittest tests.test_api.ApiTests.test_idempotency_key tests.test_api.ApiTests.test_queue_limit`，两个旧用例通过。

## T5: 对话路由

**文件：** `server/mewcode_api/main.py`  
**依赖：** T1、T3、T4  
**步骤：**
1. `POST /v1/sessions`：令牌和工作区解析与一次性任务相同，调用 `create`，返回摘要。不要求 worker 已就绪。
2. `GET /v1/sessions` 和 `GET /v1/sessions/{sessionId}`：工作区来自查询参数，缺省走现有解析。列出和打开前取 `busy_session_ids()`。打开结果若标识在忙集合里，把 `busy` 设为真。
3. `POST /v1/sessions/{sessionId}/messages`：先 `get`，确认对话属于解析后的工作区，再 `submit_for_session`。成功返回 `SendMessageResponse`。
4. 空白消息保持现有校验失败状态码。工作区不存在、越界、未授权的状态码与一次性任务相同。

**验证：** 用与 `tests/test_api.py` 相同的假 worker 和 `TestClient` 写一段临时脚本：创建后立刻列出，响应里有「新对话」；向不存在的标识发送得到 404。脚本用完即删。

## T6: 聊天页改为对话

**文件：** `server/mewcode_api/static/chat.html`  
**依赖：** T5  
**步骤：**
1. 把「最近任务」换成该工作区的对话列表。打开页面和刷新时请求 `GET /v1/sessions`。提供新建，成功后打开该对话。
2. 选中一项时请求打开接口，按顺序画出用户消息和助手回复。
3. 发送成功后先画出这句用户消息，再用返回的 `runId` 订阅现有 `/v1/runs/{runId}/events`，追加文本增量和工具活动。
4. 收到正忙时，状态区说明正忙，保留输入，不把这句画进对话。不再用浏览器里的会话标识决定打开哪一段；仍可记住工作区和令牌。文案用中文。

**验证：** `GET /chat` 的正文含「对话」，并包含 `/v1/sessions`。页面脚本在正忙分支里不把这句写入对话区域。

## T7: 测试替身写入会话

**文件：** `server/tests/fake_worker.py`  
**依赖：** 无  
**步骤：**
1. 一轮请求同时带了 `sessionsDir` 和 `sessionId`，且目标 `jsonl` 已存在时，追加一条 `user`（内容为 prompt）和一条 `assistant`（内容为 `pong`）。字段用 `type=message`、`role`、`content`、`createdAt`，以及各自的 `id`。
2. `resume` 为真时不再追加 `user`，只追加助手回复。
3. 文件不存在时不创建，避免替身变成会话目录。`WAIT_CANCEL` 仍只发 session 事件并等待，不写消息。

**验证：** 手工构造一个只有文件头的 jsonl，用假 worker 喂一行带 `sessionId` 和 `sessionsDir` 的 run，文件中随后有 user 与 assistant 各一条。`WAIT_CANCEL` 不增加消息行。

## T8: 对话接口测试

**文件：** `server/tests/test_api.py`  
**依赖：** T5、T7  
**步骤：**
1. 创建后不发送即列出，看到「新对话」。同一工作区两条对话时，后活动的在前。另一工作区的对话不出现。
2. 发送「只回复 pong」后打开，按顺序看到这句用户消息和助手 `pong`，响应里没有 tool 角色。
3. 用会触发工具的 prompt（现有 `USE_TOOL`）订阅事件流，能看到 `event: tool` 和逐步出现的正文。订阅建立在完成后，仍能看到 `pong` 和 `event: done`。
4. `WAIT_CANCEL` 期间再向同一对话发送，得到 409 和「正忙」。取消该轮之后可以再发送。
5. 另一个对话或一次性任务占着执行位置时，向空闲对话发送得到 202 而不是 409。把未结束任务顶到上限后再发送，得到与一次性任务相同的 429。
6. 工作区不存在、空白消息、错误标识、跨工作区打开，分别得到与现有任务同类的错误和中文原因。设置令牌后，不带凭证不能创建、列出、打开、发送；`/health` 仍为 200。

**验证：** `python -m unittest tests.test_api` 中上述新用例通过。

## T9: 重启与旧接口

**文件：** `server/tests/test_api.py`  
**依赖：** T8  
**步骤：**
1. 完成一轮后关掉应用，用同一数据目录和新的应用只凭工作区列出，仍能看到该对话和已保存消息，并成功再发一条。
2. 构造一条带该 `sessionId`、状态为 `running`、`inputCommitted` 为真的运行记录，重启后续跑。断言会话文件里这句用户消息只有一条。
3. 跑完现有的一次性任务用例：提交、等待、查询、取消、事件流、幂等和排队上限。
4. 确认测试没有读取或写入 `<workspace>/.mewcode/sessions`。

**验证：** 在 `server` 目录执行 `python -m unittest tests.test_api`，全部通过。

## 执行顺序

```
T1 → T2 → T3 → T5 → T6
          ↘
T4 --------→ T5 → T8 → T9
T7 ---------------↗
```
