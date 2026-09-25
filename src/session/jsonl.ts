import fs from "node:fs";
import path from "node:path";
import type { ChatMessage, Session, SessionSummary } from "./types.js";

export interface ReadSessionResult {
  session: Session;
  skippedBadLines: number;
}

export interface SessionHeaderLine {
  type: "session";
  id: string;
  title: string;
  createdAt: string;
}

export type MessageLine = { type: "message" } & ChatMessage;

export function appendLine(filePath: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(obj)}\n`, "utf8");
}

function isChatMessage(raw: Record<string, unknown>): raw is ChatMessage & Record<string, unknown> {
  return (
    typeof raw.id === "string" &&
    typeof raw.role === "string" &&
    typeof raw.content === "string" &&
    typeof raw.createdAt === "string"
  );
}

/** 从第一个未配对的 toolCalls assistant 处截断 */
export function truncateUnpairedTools(messages: ChatMessage[]): {
  messages: ChatMessage[];
  truncated: boolean;
} {
  const resultIds = new Set(
    messages.filter((m) => m.role === "tool" && m.toolCallId).map((m) => m.toolCallId!),
  );
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "assistant" || !m.toolCalls?.length) continue;
    const missing = m.toolCalls.some((tc) => !resultIds.has(tc.id));
    if (missing) {
      return { messages: messages.slice(0, i), truncated: true };
    }
  }
  return { messages, truncated: false };
}

export function readSessionFile(filePath: string): ReadSessionResult | null {
  if (!fs.existsSync(filePath)) return null;
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  const baseId = path.basename(filePath, ".jsonl");
  let id = baseId;
  let title = "新会话";
  let createdAt = new Date(0).toISOString();
  let updatedAt = createdAt;
  const messages: ChatMessage[] = [];
  let skippedBadLines = 0;
  let sawHeader = false;

  try {
    const st = fs.statSync(filePath);
    updatedAt = st.mtime.toISOString();
  } catch {
    /* ignore */
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      skippedBadLines += 1;
      continue;
    }
    if (!raw || typeof raw !== "object") {
      skippedBadLines += 1;
      continue;
    }
    const obj = raw as Record<string, unknown>;
    if (obj.type === "session") {
      sawHeader = true;
      if (typeof obj.id === "string") id = obj.id;
      if (typeof obj.title === "string") title = obj.title;
      if (typeof obj.createdAt === "string") createdAt = obj.createdAt;
      continue;
    }
    if (obj.type === "message" || isChatMessage(obj)) {
      const { type: _t, ...rest } = obj;
      if (!isChatMessage(rest as Record<string, unknown>)) {
        skippedBadLines += 1;
        continue;
      }
      const msg = rest as unknown as ChatMessage;
      messages.push({
        id: msg.id,
        role: msg.role,
        content: msg.content,
        createdAt: msg.createdAt,
        ...(msg.thinkingSummary ? { thinkingSummary: msg.thinkingSummary } : {}),
        ...(msg.toolCalls ? { toolCalls: msg.toolCalls } : {}),
        ...(msg.toolCallId ? { toolCallId: msg.toolCallId } : {}),
        ...(msg.toolName ? { toolName: msg.toolName } : {}),
        ...(msg.isError !== undefined ? { isError: msg.isError } : {}),
      });
      if (!sawHeader && msg.role === "user" && title === "新会话") {
        title = truncateTitle(msg.content);
      }
      if (msg.createdAt > createdAt && createdAt === new Date(0).toISOString()) {
        createdAt = msg.createdAt;
      }
      continue;
    }
    skippedBadLines += 1;
  }

  if (messages.length > 0) {
    const last = messages[messages.length - 1].createdAt;
    if (last > updatedAt) updatedAt = last;
    if (createdAt === new Date(0).toISOString()) {
      createdAt = messages[0].createdAt;
    }
  }

  return {
    session: { id, title, createdAt, updatedAt, messages },
    skippedBadLines,
  };
}

export function rewriteAll(filePath: string, session: Session): void {
  const lines: string[] = [];
  const header: SessionHeaderLine = {
    type: "session",
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
  };
  lines.push(JSON.stringify(header));
  for (const m of session.messages) {
    const row: MessageLine = {
      type: "message",
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
      ...(m.thinkingSummary ? { thinkingSummary: m.thinkingSummary } : {}),
      ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
      ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
      ...(m.toolName ? { toolName: m.toolName } : {}),
      ...(m.isError !== undefined ? { isError: m.isError } : {}),
    };
    lines.push(JSON.stringify(row));
  }
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${lines.join("\n")}\n`, "utf8");
  fs.renameSync(tmp, filePath);
}

export function scanSummary(filePath: string): SessionSummary | null {
  const read = readSessionFile(filePath);
  if (!read) return null;
  return {
    id: read.session.id,
    title: read.session.title,
    updatedAt: read.session.updatedAt,
    messageCount: read.session.messages.length,
  };
}

function truncateTitle(text: string, max = 40): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t || "新会话";
  return `${t.slice(0, max)}…`;
}
