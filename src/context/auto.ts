import { randomUUID } from "node:crypto";
import type { ChatProvider } from "../provider/types.js";
import type { ChatMessage } from "../session/types.js";
import { splitForCompact } from "./split.js";
import { buildSummaryPrompt, extractFormalSummary } from "./summary.js";

export type AutoCompactResult =
  | { ok: true; messages: ChatMessage[]; removedCount: number; keptCount: number }
  | { ok: false; error: string };

const BOUNDARY_TEXT = [
  "<system-reminder>",
  "上下文刚刚被压缩：较早的对话已替换为结构化摘要。",
  "若需要文件或代码的具体细节，请重新读取相关文件，不要根据摘要臆造或脑补代码内容。",
  "</system-reminder>",
].join("\n");

async function collectText(
  provider: ChatProvider,
  system: string,
  userContent: string,
  model: string,
  thinking?: boolean,
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
    thinking: Boolean(thinking),
    tools: [],
  })) {
    if (ev.type === "text_delta") text += ev.text;
    if (ev.type === "error") {
      throw new Error(ev.message);
    }
  }
  return text;
}

export async function autoCompact(opts: {
  messages: ChatMessage[];
  provider: ChatProvider;
  model: string;
  thinking?: boolean;
  userNote?: string;
}): Promise<AutoCompactResult> {
  try {
    const { older, recent } = splitForCompact(opts.messages);
    if (older.length === 0) {
      return { ok: false, error: "无需压缩：没有可摘要的较早消息" };
    }

    const prompt = buildSummaryPrompt({
      olderMessages: older,
      userNote: opts.userNote,
    });
    const raw = await collectText(
      opts.provider,
      prompt.system,
      prompt.user,
      opts.model,
      opts.thinking,
    );
    const summary = extractFormalSummary(raw);
    if (!summary.trim()) {
      return { ok: false, error: "摘要结果为空" };
    }

    const now = new Date().toISOString();
    const summaryMsg: ChatMessage = {
      id: randomUUID(),
      role: "user",
      content: ["[会话摘要]", summary].join("\n\n"),
      createdAt: now,
    };
    const boundaryMsg: ChatMessage = {
      id: randomUUID(),
      role: "user",
      content: BOUNDARY_TEXT,
      createdAt: now,
    };

    return {
      ok: true,
      messages: [summaryMsg, boundaryMsg, ...recent],
      removedCount: older.length,
      keptCount: recent.length,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
