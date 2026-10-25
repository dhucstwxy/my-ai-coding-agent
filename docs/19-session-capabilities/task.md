# 会话审批与扩展能力 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
| --- | --- | --- |
| 新建 | `src/run/session-turn.ts` | `runSessionTurn`：默认档、技能、Hooks、MCP |
| 修改 | `src/serve/worker.ts` | 分发 `session-run` 与 `approval`，进程级会话放行存储 |
| 修改 | `server/mewcode_api/models.py` | 选择请求体 |
| 修改 | `server/mewcode_api/worker_client.py` | 把选择写给执行进程 |
| 修改 | `server/mewcode_api/run_manager.py` | 会话一轮走 `session-run`，转发询问和警告，`answer_approval` |
| 修改 | `server/mewcode_api/main.py` | `POST /v1/runs/{runId}/approval` |
| 修改 | `server/mewcode_api/static/chat.html` | 四个中文选择 |
| 修改 | `server/tests/fake_worker.py` | 识别 `session-run`，按提示发出询问 |
| 修改 | `server/tests/test_api.py` | 询问、选择、一次性任务拒绝选择 |

`src/run/runner.ts`、`src/permission/`、`src/cli.ts` 不改。

## T1: 标出会话一轮

**文件：** `server/mewcode_api/run_manager.py`  
**依赖：** 无  
**步骤：**
1. 给 `RunState` 增加 `session_turn`，默认假。写入运行记录，重启时读回。
2. 只有 `submit_for_session` 把它设为真。现有 `submit` 保持假，即使请求里带了会话标识。
3. `_consume` 在 `session_turn` 为真时，把载荷的 `type` 写成 `session-run`，其余字段不变。否则仍是 `run`。

**验证：** 临时脚本替换 worker 的发送函数，只记录载荷并立刻返回完成。会话发送的载荷 `type` 为 `session-run`，一次性任务仍为 `run`。脚本用完即删。现有 `python -m unittest tests.test_api.ApiTests.test_health_and_one_shot` 通过。

## T2: 选择请求体

**文件：** `server/mewcode_api/models.py`  
**依赖：** 无  
**步骤：**
1. 增加 `ApprovalBody`：`approvalId` 为非空字符串，`choice` 只能是 `deny`、`once`、`session`、`permanent`。
2. 空白的 `approvalId` 判为非法。

**验证：** `python -c "from mewcode_api.models import ApprovalBody; ApprovalBody(approvalId='a', choice='once')"` 成功。`choice='allow'` 构造失败。

## T3: 把选择写给执行进程

**文件：** `server/mewcode_api/worker_client.py`  
**依赖：** 无  
**步骤：**
1. 增加 `approve(request_id, approval_id, choice)`，写入一行 `{"type":"approval","requestId","approvalId","choice"}`。
2. 不新开一轮，也不取消现有的 `run` 读取循环。

**验证：** 用假的已启动管道调用 `approve`，读到的一行 JSON 含这四个字段。临时脚本用完即删。

## T4: 会话一轮的权限与循环

**文件：** `src/run/session-turn.ts`  
**依赖：** 无  
**步骤：**
1. 导出 `runSessionTurn`。参数包含工作区、提示、会话标识、会话目录、超时、取消令牌、共享的 `SessionGrantStore`，以及 `onEvent`、`onWarning`。
2. 读取与终端相同的权限规则，档位只设为 `default`。只注册六个内置工具。确认器先把询问交给 `onEvent`，再等待外部选择。
3. 用现有代理循环跑完这一轮。黑名单和路径限制仍走现有闸门。不调用 `runHeadless`，不注册小组或子代理工具。
4. 返回与无头执行相同形态的报告。

**验证：** `npm run typecheck` 通过。用临时脚本对一个会写文件的调用检查：默认档下出现询问；选择 `deny` 后工具未执行，循环得到拒绝。脚本用完即删。

## T5: 接上技能、Hooks 和 MCP

**文件：** `src/run/session-turn.ts`  
**依赖：** T4  
**步骤：**
1. 在六个内置工具之外，只注册模型可调用的技能加载工具。不注册斜杠命令。
2. 连接该工作区的 MCP，并把远端工具标成有副作用。某一项失败时调用 `onWarning`，不中断这一轮。
3. 按终端的生命周期触发 Hooks。单项失败同样只警告。
4. 无论成功或失败，结束时关闭 MCP，并结束这一轮的 Hooks。

**验证：** `npm run typecheck` 通过。临时工作区不配置这三项时，一轮仍能完成，工具列表里有技能加载工具。配置一个必然失败的 MCP 时，`onWarning` 收到中文消息，进程不退出。

## T6: 执行进程分发

**文件：** `src/serve/worker.ts`  
**依赖：** T5  
**步骤：**
1. 进程启动时创建一个 `SessionGrantStore`，所有 `session-run` 共用。
2. `session-run` 调用 `runSessionTurn`，把文本、工具、询问和警告按现有事件行写回。`run` 仍调用 `runHeadless`。
3. 每个 `requestId` 最多挂起一个询问。收到匹配的 `approval` 时唤醒它。取消、超时或进程退出时用 `deny` 解除。
4. 本会话放行写入这个共享存储。不把存储写入会话文件。

**验证：** `npm run typecheck` 通过。用临时脚本向 worker 写 `session-run`，看到询问事件；再写 `approval` 的 `once`，该轮继续并结束。再写一条 `run`，事件里没有询问。

## T7: 转发询问并接受回答

**文件：** `server/mewcode_api/run_manager.py`、`server/mewcode_api/main.py`  
**依赖：** T1、T2、T3、T6  
**步骤：**
1. 把执行进程的询问转成事件流上的 `approval`。`pending` 含工具名、对象、参数摘要和四个选择。结束时再发 `allowed` 或 `denied`。警告转成 `warning`。
2. 未结束的 `pending` 留在这一轮的事件缓冲里，晚订阅能先看到它。
3. `answer_approval` 只接受 `session_turn` 为真、标识匹配且仍在等待的一轮，然后调用 worker 的 `approve`。否则 409，中文说明原因。任务不存在仍是 404。
4. `POST /v1/runs/{runId}/approval` 使用与会话发送相同的令牌校验。

**验证：** 假 worker 尚未改之前，用临时脚本调用不存在的任务，得到 404。现有一次性任务测试仍通过。

## T8: 聊天页四个选择

**文件：** `server/mewcode_api/static/chat.html`  
**依赖：** T7  
**步骤：**
1. 收到 `pending` 时，在当前轮输出下显示工具名、对象、参数摘要，以及拒绝、仅本次放行、本会话放行、永久放行四个按钮。
2. 点击后提交对应的 `choice`，按钮消失。
3. 收到该询问的 `denied` 或 `allowed`，或这一轮的 `done` 先到，把未答询问标成已拒绝，按钮不可再点。
4. 不增加斜杠命令和档位切换。

**验证：** `GET /chat` 的正文含这四个中文标签和 `/approval`。正忙分支仍在把用户消息画进对话之前返回。

## T9: 替身与接口测试

**文件：** `server/tests/fake_worker.py`、`server/tests/test_api.py`  
**依赖：** T7、T8  
**步骤：**
1. 假 worker 对 `session-run` 且提示为 `ASK` 时，发出一条 `pending` 询问并等待 `approval`。收到 `once` 后按成功结束；收到 `deny` 后按失败结束且不写工具结果。`run` 不发询问。
2. 测试：会话发送 `ASK` 后事件流有 `approval`，四个选择都在。提交 `once` 后该轮完成。再提交同一次询问得到 409。
3. 测试：不回答就取消，事件里该询问为 `denied`，对话可以再发。另一段空闲对话在等待期间仍能得到 202。
4. 测试：一次性任务的 `/approval` 得到 409。原有提交、等待、查询、取消和事件流测试仍通过。不带凭证时选择接口为 401，健康检查为 200。

**验证：** 在 `server` 目录执行 `python -m unittest tests.test_api`，全部通过。

## 执行顺序

```
T1 → T7
T2 → T7 → T8 → T9
T3 → T7
T4 → T5 → T6 → T7
```
