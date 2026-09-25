# 记忆与会话 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/instructions/include.ts` | @include 展开与路径安全 |
| 新建 | `src/instructions/load.ts` | 三层 AGENTS.md |
| 新建 | `src/instructions/index.ts` | 导出 |
| 新建 | `src/session/id.ts` | 会话 ID |
| 新建 | `src/session/jsonl.ts` | JSONL 读写/扫描/截断 |
| 新建 | `src/session/cleanup.ts` | 30 天清理 |
| 新建 | `src/session/restore.ts` | normalize + time gap |
| 重写 | `src/session/store.ts` | 项目目录 JSONL Store |
| 修改 | `src/session/types.ts` | 可选 messageCount |
| 修改 | `src/config/paths.ts` | projectSessionsDir / memory 路径 |
| 新建 | `src/memory/paths.ts` | 记忆目录 |
| 新建 | `src/memory/index-load.ts` | INDEX 加载截断 |
| 新建 | `src/memory/notes.ts` | 笔记读写 |
| 新建 | `src/memory/update.ts` | 异步更新 |
| 新建 | `src/memory/index.ts` | 导出 |
| 修改 | `src/prompt/types.ts` / `reminder.ts` | time_gap 提醒种类（若需要） |
| 修改 | `src/agent/loop.ts` | 注入指令/记忆；完成时更新；时间提醒 |
| 修改 | `src/cli.ts` | cleanup + 预载 + store 路径 |
| 修改 | `.gitignore` | 忽略 `.mewcode/sessions/` |

## T1: 路径常量

**文件：** `src/config/paths.ts`  
**依赖：** 无  
**步骤：**
1. 新增 `projectSessionsDir(cwd)` → `<cwd>/.mewcode/sessions`
2. 新增 `projectMemoryDir(cwd)` → `<cwd>/.mewcode/memory`
3. 新增 `userMemoryDir(home)` → `~/.mewcode/memory`
4. 保留旧 `sessionsDir` 可标记废弃或删除（本步改为不再被 Store 默认使用）

**验证：** `npm run typecheck`

## T2: @include 展开

**文件：** `src/instructions/include.ts`  
**依赖：** 无  
**步骤：**
1. 识别行内或整行 `@include <relpath>`（实现选整行优先，文档写清）
2. `resolveSafe(root, rel)`：join + normalize/realpath，必须仍在 root 下
3. `expandIncludes(content, { rootDir, maxDepth, visited, depth })`：递归展开；越界/环/超深跳过并收集 warnings

**验证：** `npx tsx` 临时目录：合法 include 展开；自引用环警告；`../` 逃逸跳过。脚本删

## T3: 三层指令加载

**文件：** `src/instructions/load.ts`、`index.ts`  
**依赖：** T2  
**步骤：**
1. 依次读：`<cwd>/AGENTS.md`、`<cwd>/.mewcode/AGENTS.md`、`~/.mewcode/AGENTS.md`
2. 每层各自 root：项目两层用 cwd；用户层用 `~/.mewcode`
3. 高优先级在前拼接，层间空行分隔；总长超 100KB 截断并 warning
4. 导出 `loadInstructions(workspaceRoot)`

**验证：** 三层不同内容时顺序正确；缺文件不抛错。脚本删

## T4: 会话 ID

**文件：** `src/session/id.ts`  
**依赖：** 无  
**步骤：**
1. `generateSessionId(now = new Date())` → `YYYYMMDD-HHMMSS-` + 4 位以上随机（字母数字）

**验证：** 正则匹配；同秒两次调用后缀不同（高概率）。脚本删

## T5: JSONL 读写与截断

**文件：** `src/session/jsonl.ts`  
**依赖：** 无  
**步骤：**
1. `appendLine(file, obj)` 追加一行 JSON + `\n`
2. `readSessionFile(file)`：逐行 parse；坏行跳过；组装 Session；统计 skipped
3. `truncateUnpairedTools(messages)`：从第一个「assistant 带 toolCalls 但后续缺少对应 tool 结果」处截断
4. `rewriteAll(file, session)`：header + 全部 message 行原子写（先写临时文件再 rename）
5. `scanSummary(file)`：id/title/updatedAt/messageCount

**验证：** 造含坏行与未配对 tool 的文件，读回符合预期。脚本删

## T6: SessionStore 重写

**文件：** `src/session/store.ts`、`types.ts`  
**依赖：** T1、T4、T5  
**步骤：**
1. 构造函数改为 `constructor(dir: string)`（必传项目 sessions 目录）
2. `create`：生成 id，写 header 行
3. `appendMessage`：appendLine message
4. `replaceMessages`：rewriteAll
5. `get`：readSessionFile + truncateUnpairedTools
6. `list`：扫 `*.jsonl` 的 scanSummary，按 updatedAt 排序
7. `writeToolResult`：`dir/{sessionId}/tool-results/{id}.txt`
8. `SessionSummary` 增加可选 `messageCount`

**验证：** 临时目录完整走 create→append→get→replace→list。脚本删

## T7: 过期清理

**文件：** `src/session/cleanup.ts`  
**依赖：** T6  
**步骤：**
1. `cleanupExpiredSessions(dir, now)`：updatedAt 或 mtime 早于 30 天的 jsonl 删除，并 rm `dir/{id}/` 若存在
2. 返回 removed ids

**验证：** 造一个改 mtime/伪造旧 header 的文件，清理后消失。脚本删

## T8: restore 与时间 gap

**文件：** `src/session/restore.ts`  
**依赖：** T5  
**步骤：**
1. `normalizeSession` 包装截断结果
2. `needsTimeGapReminder(lastMessageAt, now)`：差值 > 24h

**验证：** 边界 23h/25h 断言。脚本删

## T9: 记忆路径与 INDEX 加载

**文件：** `src/memory/paths.ts`、`index-load.ts`  
**依赖：** T1  
**步骤：**
1. 封装 project/user memory 路径与 `notes/` 子目录
2. `loadMemoryText(workspaceRoot)`：读两份 INDEX.md（可缺），项目在前；合并后按 200 行与 25KB 截断

**验证：** 超大 INDEX 注入结果不超过上限。脚本删

## T10: 笔记读写

**文件：** `src/memory/notes.ts`  
**依赖：** T9  
**步骤：**
1. 解析/序列化 frontmatter（可用简单正则或现有依赖；无依赖则手写 `---` 块）
2. `writeNote(scope, note)` / `listNotes(scope)` 

**验证：** 写读 roundtrip。脚本删

## T11: 异步记忆更新

**文件：** `src/memory/update.ts`、`index.ts`  
**依赖：** T9、T10  
**步骤：**
1. `buildMemoryUpdatePrompt(recentMessages, indexes)`：要求输出四类归类、去重、给出要写的笔记与新 INDEX 文本（约定可解析格式，如 JSON 代码块）
2. `runMemoryUpdate(...)`：调用 provider（tools 空）；解析；写 notes；写 INDEX；抛错由调用方吞
3. `scheduleMemoryUpdate(...)`：`void runMemoryUpdate().catch(() => {})`

**验证：** 假 Provider 返回固定 JSON，断言 notes/INDEX 文件出现。脚本删

## T12: Loop 注入指令与记忆

**文件：** `src/agent/loop.ts`  
**依赖：** T3、T9  
**步骤：**
1. 构造注入 `customInstructions` / `memoryText`（或每轮从缓存读取）
2. `buildPrompt` 传入上述字段

**验证：** `npm run typecheck`；可用假文件断言 built.sections 含内容（tsx）

## T13: 时间提醒 + 完成时调度记忆

**文件：** `src/agent/loop.ts`、必要时 `prompt/reminder.ts`  
**依赖：** T8、T11、T12  
**步骤：**
1. 维护 `lastMessageAt`（从 session 最后一条 createdAt）
2. 若 `needsTimeGapReminder`，在 reminders 中追加时间跨度中文说明
3. `toolCalls.length===0` 分支：先 yield stop/done，再 `scheduleMemoryUpdate`（不 await）

**验证：** typecheck；可用计数器断言 schedule 被调用且不阻塞（假 update delay）

## T14: CLI 装配与 gitignore

**文件：** `src/cli.ts`、`.gitignore`  
**依赖：** T6、T7、T12  
**步骤：**
1. `SessionStore(projectSessionsDir(cwd))`
2. 启动调用 cleanup
3. 预载 instructions/memory，warnings 并入 TUI
4. `.gitignore` 增加 `.mewcode/sessions/`

**验证：** `npm run typecheck`；确认 gitignore 含该行

## 执行顺序

```
T1 → T2 → T3
T1 → T4 → T5 → T6 → T7
T5 → T8
T1 → T9 → T10 → T11
T3+T9 → T12 → T13
T6+T7+T12 → T14
```

推荐串行：T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10 → T11 → T12 → T13 → T14。
