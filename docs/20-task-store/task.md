# 任务管理与持久化 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
| --- | --- | --- |
| 新建 | `server/mewcode_api/task_store.py` | SQLite 任务库 |
| 新建 | `server/mewcode_api/step_collector.py` | 把事件收成已完成的 Step |
| 新建 | `server/tests/test_task_store.py` | 任务库与步骤收集的直接验证 |
| 修改 | `server/mewcode_api/run_manager.py` | 状态改走任务库，完成事件先落库再发布 |
| 修改 | `server/mewcode_api/main.py` | `GET /v1/runs/{runId}/steps` |
| 修改 | `server/mewcode_api/models.py` | 步骤响应字段 |
| 修改 | `server/mewcode_api/static/chat.html` | 对话列表放到左侧 |
| 删除 | `server/mewcode_api/run_store.py` | 不再读写 JSON 运行记录 |
| 修改 | `src/agent/scheduler.ts` | 工具结束事件带上 `subject` |
| 修改 | `server/tests/fake_worker.py` | 思考、工具和正文事件，工具带 `subject` |
| 修改 | `server/tests/test_api.py` | 步骤查询、重启、旧 JSON、库不可用、左侧列表 |

`src/run/session-turn.ts`、`src/permission/`、`src/cli.ts` 不改。聊天页不调用步骤查询。

## T1: 任务库

**文件：** `server/mewcode_api/task_store.py`、`server/tests/test_task_store.py`  
**依赖：** 无  
**步骤：**
1. 在服务数据目录创建 `tasks.sqlite`，建 Task 表和 Step 表。Task 字段与 plan 的 Task 一致，主键是 `runId`。Step 按 `runId` 加 `seq` 唯一，`seq` 从 1 递增。
2. 实现 `load_tasks`、`save_task`、`append_step`、`load_steps`。`save_task` 按 `runId` 插入或更新。`load_steps` 按 `seq` 升序。
3. 库文件打不开时，构造或调用失败，异常信息包含「任务库不可用」。不创建 `runs/*.json`。

**验证：** 在 `server` 目录执行 `python -m unittest tests.test_task_store.TaskStoreTests`。临时目录里写入后能读回；第二次 `save_task` 更新同一 `runId`；两条 Step 的 `seq` 为 1 和 2。把库路径指到一个已存在的普通文件上，打开失败且信息含「任务库不可用」。

## T2: 步骤收集

**文件：** `server/mewcode_api/step_collector.py`、`server/tests/test_task_store.py`  
**依赖：** 无  
**步骤：**
1. `observe` 对 `text_delta` 只累积，不返回 Step。
2. `thinking_end` 返回一条 `kind=thinking`，`text` 为摘要。没有思考事件就不产生这类步骤。
3. 工具开始前，若正文累积非空，先返回一条 `kind=text`。`tool_execution_end` 返回一条 `kind=tool`，带上 `tool`、`subject`、`ok`、`summary`。`subject` 缺失时为空字符串。
4. `note_approval` 和 `note_warning` 只附在当前打开的工具上。工具结束时写入该 Step。没有打开的工具时，警告不产生 Step。
5. `flush` 返回尚未交出的正文；没有则返回空。未结束的工具不在 `flush` 里变成 Step。

**验证：** `python -m unittest tests.test_task_store.StepCollectorTests`。依次喂入思考结束、正文增量、工具开始、审批、警告、工具结束、再一段正文和 `flush`。得到思考、第一段正文、工具、第二段正文四条，顺序不变。工具步骤含审批和警告。只喂工具开始时没有工具步骤。单独的警告没有步骤。

## T3: 工具结束带上对象

**文件：** `src/agent/scheduler.ts`  
**依赖：** 无  
**步骤：**
1. 所有产出 `tool_execution_end` 的位置都带上 `subject`。对象用现有的权限对象计算，入参是工具名和这次调用的参数。
2. 算不出对象时省略该字段。不改权限判断的结果，也不改事件流里现有的 `name`、`ok`、`resultSummary`。

**验证：** `npm run typecheck` 通过。检索 `tool_execution_end`，每一处产出都有 `subject`。

## T4: 队列改走任务库

**文件：** `server/mewcode_api/run_manager.py`；删除 `server/mewcode_api/run_store.py`  
**依赖：** T1  
**步骤：**
1. `RunManager` 改为持有 `TaskStore`。`save_task` 替代原来的 JSON 记录写入，字段仍来自现有的任务记录。
2. 事件只追加到内存列表，不再调用事件文件的追加、读取和清空。重启恢复时事件列表为空。
3. `restore` 从 `load_tasks` 读回。未完成任务的重新排队、次数上限、`resume` 和 `inputCommitted` 条件保持现有分支。
4. 库不可用时，`submit` 和 `submit_for_session` 返回 503，详情为「任务库不可用」。
5. 删除 `run_store.py`，仓库里不再引用它。

**验证：** `python -m unittest tests.test_api.ApiTests.test_health_and_one_shot tests.test_api.ApiTests.test_session_approval_choices_and_conflicts` 通过。数据目录里不新增 `runs/*.json`。

## T5: 完成事件先落库

**文件：** `server/mewcode_api/run_manager.py`  
**依赖：** T2、T4  
**步骤：**
1. 每个 Task 带一个步骤收集器。正文增量仍先发布到事件流。
2. 思考结束、工具结束，以及工具开始前要交出的正文，都先 `append_step`，再发布对应事件。
3. 审批和警告仍先进入事件流，并通知步骤收集器。一轮结束前 `flush`，有正文则先落库，再把任务标为结束并发布结束事件。
4. 重启重新排队时保留库里的 Step，只清空内存事件。

**验证：** 临时脚本用假的执行事件驱动一次队列消费：先看到库里的 Step，随后内存事件里才出现对应完成事件。脚本用完即删。

## T6: 读取步骤的接口

**文件：** `server/mewcode_api/models.py`、`server/mewcode_api/main.py`  
**依赖：** T4、T5  
**步骤：**
1. 增加步骤响应模型，字段与 plan 的 Step 一致。没有用到的种类字段不出现。
2. 增加 `GET /v1/runs/{runId}/steps`，访问限制与查询该任务相同。
3. 调用 `steps(run_id)`。任务不存在时与查询该任务的状态码相同。

**验证：** 路由已注册。现有不带凭证访问任务的测试仍然是 401。健康检查仍为 200。

## T7: 对话列表放到左侧

**文件：** `server/mewcode_api/static/chat.html`  
**依赖：** 无  
**步骤：**
1. 页面改为横向布局。左侧是现有对话列表，右侧是输入和这一轮输出。
2. 列表的数据、点开对话和订阅事件流的逻辑不改。不请求 `/steps`。
3. 窄页面仍能看到左侧列表和主区域，不把列表放回正文下方。

**验证：** `GET /chat` 的页面里，对话列表节点出现在正文区域之前，样式是横向排列。页面文本不含 `/steps`。现有「409 先于画出用户消息」的断言仍成立。

## T8: 接口验收

**文件：** `server/tests/fake_worker.py`、`server/tests/test_api.py`  
**依赖：** T3、T5、T6、T7  
**步骤：**
1. 假执行进程在会话一轮里，当提示为 `STEPS` 时依次发出思考结束、正文增量、工具开始、工具结束和结束。工具结束带 `subject`。普通提示的现有行为不变。
2. 测试步骤顺序为思考、正文、工具。工具步骤含名称、对象、成败和摘要。文本增量不是步骤。
3. 工具尚未结束时查询步骤，结果里没有该工具步骤；事件流出现工具结束后再查，该步骤在。
4. 重启服务进程后，同一 `runId` 的步骤仍在。数据目录里预先放一个旧的 `runs/*.json`，列表里没有它。
5. 库打不开时提交任务得到 503，详情含「任务库不可用」，`/health` 为 200。
6. 一次性任务仍无审批。会话审批、忙闲和取消的现有测试保持通过。

**验证：** 在 `server` 目录执行 `python -m unittest tests.test_api tests.test_task_store`，全部通过。仓库根目录 `npm run typecheck` 通过。

## 执行顺序

```
T1 → T4 → T5 → T6 → T8
T2 ────────↗
T3 ────────────────↗
T7 ────────────────↗
```
