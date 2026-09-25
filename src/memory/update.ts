import { randomUUID } from "node:crypto";
import type { ChatProvider } from "../provider/types.js";
import type { ChatMessage } from "../session/types.js";
import { memoryIndexPath } from "./paths.js";
import {
  createNoteId,
  writeIndexFile,
  writeNote,
  type MemoryNoteType,
} from "./notes.js";
import fs from "node:fs";

export interface MemoryUpdateInput {
  workspaceRoot: string;
  sessionId: string;
  recentMessages: ChatMessage[];
  provider: ChatProvider;
  model: string;
}

interface ParsedUpdate {
  notes: Array<{
    scope: "user" | "project";
    type: MemoryNoteType;
    title?: string;
    body: string;
  }>;
  indexProject?: string;
  indexUser?: string;
}

function readIndexSafe(filePath: string): string {
  try {
    if (!fs.existsSync(filePath)) return "";
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function buildPrompt(
  recent: ChatMessage[],
  indexProject: string,
  indexUser: string,
): { system: string; user: string } {
  const system = [
    "你是记忆整理助手。根据最近对话，提取值得长期保留的信息。",
    "严禁调用任何工具。",
    "只输出一个 JSON 对象（可包在 ```json 代码块中），字段：",
    '- notes: 数组，每项含 scope("user"|"project"), type("user_preference"|"feedback"|"project_knowledge"|"reference"), title?, body',
    "- indexProject: 可选，完整替换项目 INDEX.md 的正文",
    "- indexUser: 可选，完整替换用户 INDEX.md 的正文",
    "若无需更新，返回 {\"notes\":[]}。请去重，避免重复已有索引内容。",
  ].join("\n");

  const hist = recent
    .slice(-30)
    .map((m) => `[${m.role}] ${m.content.slice(0, 2000)}`)
    .join("\n---\n");

  const user = [
    "现有项目索引：",
    indexProject || "（空）",
    "",
    "现有用户索引：",
    indexUser || "（空）",
    "",
    "最近对话：",
    hist,
  ].join("\n");

  return { system, user };
}

function extractJson(raw: string): ParsedUpdate {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const text = (fence ? fence[1] : raw).trim();
  const data = JSON.parse(text) as ParsedUpdate;
  if (!data || !Array.isArray(data.notes)) {
    return { notes: [] };
  }
  return data;
}

async function collectText(
  provider: ChatProvider,
  system: string,
  userContent: string,
  model: string,
): Promise<string> {
  let text = "";
  for await (const ev of provider.streamChat({
    system,
    messages: [
      {
        id: randomUUID(),
        role: "user",
        content: userContent,
        createdAt: new Date().toISOString(),
      },
    ],
    model,
    tools: [],
  })) {
    if (ev.type === "text_delta") text += ev.text;
    if (ev.type === "error") throw new Error(ev.message);
  }
  return text;
}

export async function runMemoryUpdate(input: MemoryUpdateInput): Promise<void> {
  const indexProject = readIndexSafe(
    memoryIndexPath("project", input.workspaceRoot),
  );
  const indexUser = readIndexSafe(memoryIndexPath("user", input.workspaceRoot));
  const prompt = buildPrompt(input.recentMessages, indexProject, indexUser);
  const raw = await collectText(
    input.provider,
    prompt.system,
    prompt.user,
    input.model,
  );
  const parsed = extractJson(raw);
  const now = new Date().toISOString();
  for (const n of parsed.notes) {
    if (!n.body?.trim()) continue;
    writeNote(input.workspaceRoot, {
      id: createNoteId(),
      type: n.type,
      scope: n.scope,
      createdAt: now,
      updatedAt: now,
      title: n.title,
      body: n.body,
    });
  }
  if (typeof parsed.indexProject === "string") {
    writeIndexFile("project", input.workspaceRoot, parsed.indexProject);
  }
  if (typeof parsed.indexUser === "string") {
    writeIndexFile("user", input.workspaceRoot, parsed.indexUser);
  }
}

/** 后台更新；失败静默 */
export function scheduleMemoryUpdate(input: MemoryUpdateInput): void {
  void runMemoryUpdate(input).catch(() => {
    /* 静默 */
  });
}
