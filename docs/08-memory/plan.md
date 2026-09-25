# 记忆与会话 Plan

## 架构概览

在现有 Prompt 槽与 Agent Loop 之上，增加三块并列能力，并重写会话存储为项目内 JSONL。

| 组件 | 职责 |
|------|------|
| **InstructionsLoader** | 按优先级加载三层 AGENTS.md，展开 @include，截断/告警，输出 customInstructions 文本 |
| **MemoryStore + MemoryIndexer** | 读写用户/项目 memory/ 笔记与索引；加载时裁到 200 行/25KB，输出 memoryText |
| **MemoryUpdater** | 自然完成后异步调 LLM，更新笔记与索引；失败吞掉 |
| **JsonlSessionStore** | 替换现有整文件 JSON：create/list/get/append/replace；坏行跳过、工具配对截断；ID 生成；30 天清理；tool-results 在项目 sessions 下 |
| **SessionRestore** | 打开会话时：截断修复；记录 lastActiveAt 供时间提醒 |
| **TimeGapReminder** | 距上次活动超过 24h 时，向当次请求插入临时 system-reminder（不落盘） |
| **启动装配** | cli：项目 sessions 目录、清理过期、把 loader/indexer 结果交给 Loop |

数据流：

```
启动
  → 清理超过 30 天的 sessions
  → 预载 instructions + memory index

每次模型请求前
  → buildPrompt({ customInstructions, memoryText })
  → 若需时间提醒 → reminders += time_gap
  → ContextPipeline（既有）
  → streamChat

自然完成（无 toolCalls）
  → 先 stop/done 给 UI
  → 后台 void MemoryUpdater.run(...)  // 不 await
```

与 spec：F1–F4→Instructions；F5–F9/F15→JsonlSession；F10–F14→Memory；F8 压缩→复用 ContextPipeline；F8 时间→Reminder。

## 核心数据结构

### InstructionLoadResult
- `text: string` — 已按优先级拼接并展开 include
- `warnings: string[]`

### IncludeOptions
- `maxDepth = 5`
- `rootDir: string` — 允许读取的根（项目根或用户 .mewcode）
- `visited: Set<string>` — 规范化绝对路径

### Jsonl 行类型
- `header`（文件首行，可选但推荐）：`{ type:"session", id, title, createdAt }`
- `message`：`{ type:"message", ...ChatMessage 字段 }`
- 列表扫描：无 header 时用文件名作 id；标题取首条 user 消息截断；`updatedAt` 用文件 mtime；`messageCount` 计成功解析的 message 行

### SessionSummary
- `id`, `title`, `updatedAt`；可选 `messageCount?: number`

### MemoryNoteType
`"user_preference" | "feedback" | "project_knowledge" | "reference"`

### MemoryNote（文件）
- Frontmatter：`id`, `type`, `scope: "user" | "project"`, `createdAt`, `updatedAt`, `title?`
- Body：Markdown 正文
- 路径：`{memoryDir}/notes/{id}.md`

### MemoryIndex
- 文件：`{memoryDir}/INDEX.md`
- 内容：短条目列表，由 Updater 维护；Loader 读取后做行数/字节截断

### MemoryLoadResult
- `text: string` — 项目索引在前，用户索引在后
- `warnings: string[]`

### MemoryUpdateInput
- `sessionId`, `recentMessages: ChatMessage[]`
- `existingIndexUser`, `existingIndexProject`
- `provider` / `model` 与对话相同

### RestoreResult
- `session: Session`
- `skippedBadLines: number`
- `truncatedTail: boolean`
- `lastMessageAt: string`

### 常量
- `INCLUDE_MAX_DEPTH = 5`
- `INSTRUCTIONS_MAX_BYTES = 100_000`
- `MEMORY_INDEX_MAX_LINES = 200`
- `MEMORY_INDEX_MAX_BYTES = 25_000`
- `SESSION_TTL_DAYS = 30`
- `TIME_GAP_HOURS = 24`

## 模块设计

### `instructions/load.ts`
**职责：** F1–F4。读三层 AGENTS.md，展开 @include，合并截断。  
**对外：** `loadInstructions(workspaceRoot): InstructionLoadResult`  
**依赖：** include.ts、fs。

### `instructions/include.ts`
**职责：** 单文件展开；匹配 `@include path`；`resolveSafe(root, rel)`。  
**对外：** `expandIncludes(content, opts): { text, warnings }`

### `session/store.ts`（重写）
**职责：** JSONL 会话 CRUD；目录为 `workspaceRoot/.mewcode/sessions`。  
**对外：** 保持 `list/create/get/appendMessage/replaceMessages/updateTitle/writeToolResult`。  
**依赖：** jsonl.ts、id.ts。

### `session/jsonl.ts`
**职责：** 按行读写、坏行跳过、工具配对截断、从文件推导 summary。  
**对外：** `readSessionFile` / `appendLine` / `rewriteAll` / `scanSummary`

### `session/id.ts`
**职责：** `generateSessionId(): string` → `YYYYMMDD-HHMMSS-xxxx`

### `session/cleanup.ts`
**职责：** F9。删除超过 30 天未更新的 `.jsonl` 及 `{id}/` 目录。  
**对外：** `cleanupExpiredSessions(sessionsDir, now): { removed: string[] }`

### `session/restore.ts`
**职责：** get 后规范化；时间 gap 判断。  
**对外：** `normalizeSession(session): RestoreResult`；`needsTimeGapReminder(lastMessageAt, now): boolean`

### `memory/*`
**职责：** 路径、INDEX 加载截断、笔记读写、异步 LLM 更新。  
**对外：** `loadMemoryText(workspaceRoot)`；`scheduleMemoryUpdate(input)`（fire-and-forget）

### 挂载点
- `config/paths.ts`：`projectSessionsDir` / `projectMemoryDir` / `userMemoryDir`
- `agent/loop.ts`：注入 instructions/memory；completed 时 schedule；time_gap reminder
- `cli.ts`：启动 cleanup；store 注入 workspaceRoot；预载缓存
- `.gitignore`：忽略 `.mewcode/sessions/`

## 模块交互

### 启动
```
cli → cleanupExpiredSessions → SessionStore(projectSessionsDir)
    → loadInstructions + loadMemoryText → 缓存 → TUI warnings
```

### 每轮请求
```
AgentLoop
  → time_gap? → 临时 reminder
  → buildPrompt({ customInstructions, memoryText })
  → ContextPipeline
  → streamChat → append/replace JSONL
```

### 自然完成
```
无 toolCalls → yield stopped/done → void scheduleMemoryUpdate(...)
```

### 恢复压缩
F8「恢复后先压」由每轮请求前既有 ContextPipeline 覆盖，不另开恢复专用入口。

### @include 安全
realpath 必须落在约定 root 内；visited 防环；depth>5 跳过并警告。

## 文件组织

```
src/
├── instructions/
│   ├── include.ts
│   ├── load.ts
│   └── index.ts
├── memory/
│   ├── paths.ts
│   ├── index-load.ts
│   ├── notes.ts
│   ├── update.ts
│   └── index.ts
├── session/
│   ├── id.ts
│   ├── jsonl.ts
│   ├── cleanup.ts
│   ├── restore.ts
│   ├── store.ts
│   └── types.ts
├── config/paths.ts
├── agent/loop.ts
├── cli.ts
└── .gitignore

docs/08-memory/
├── spec.md
└── plan.md
```

运行时布局：

```
<workspace>/AGENTS.md
<workspace>/.mewcode/AGENTS.md
<workspace>/.mewcode/sessions/{id}.jsonl
<workspace>/.mewcode/sessions/{id}/tool-results/
<workspace>/.mewcode/memory/INDEX.md
<workspace>/.mewcode/memory/notes/*.md
~/.mewcode/AGENTS.md
~/.mewcode/memory/INDEX.md
~/.mewcode/memory/notes/*.md
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 会话格式 | 项目内 JSONL + 可选 header 行 | 满足追加/容错/无 meta |
| 旧全局 JSON | 直接废弃 | 已确认仅测试数据 |
| 恢复压缩 | 复用每轮前 ContextPipeline | 避免双入口，满足 F8/N5 |
| 时间提醒 | 临时 reminder，不落盘 | 与现有 reminder 一致 |
| 记忆更新 | completed 后 fire-and-forget | 满足 N4/F14 |
| 索引顺序 | 项目 INDEX 在前，用户在后 | 当前项目优先 |
| sessions gitignore | 默认忽略 | 避免把对话提交进仓库 |
| replaceMessages | 整文件重写 JSONL | 压缩需要；热路径仍用 append |

## Spec 覆盖

| F | 归属 |
|---|------|
| F1–F4 | instructions/* |
| F5–F9, F15 | session/* + paths |
| F10–F14 | memory/* + loop |
| F8 时间 | restore + reminder |
| F8 压缩 | 既有 context pipeline |
