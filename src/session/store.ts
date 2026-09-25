import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sessionsDir } from "../config/paths.js";
import type { ChatMessage, Session, SessionSummary } from "./types.js";

export class SessionStore {
  private readonly dir: string;

  constructor(dir = sessionsDir()) {
    this.dir = dir;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  list(): SessionSummary[] {
    const files = fs.readdirSync(this.dir).filter((f) => f.endsWith(".json"));
    const summaries: SessionSummary[] = [];
    for (const file of files) {
      const session = this.readFile(path.join(this.dir, file));
      if (!session) continue;
      summaries.push({
        id: session.id,
        title: session.title,
        updatedAt: session.updatedAt,
      });
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  create(title = "新会话"): Session {
    const now = new Date().toISOString();
    const session: Session = {
      id: randomUUID(),
      title,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    this.write(session);
    return session;
  }

  get(id: string): Session | null {
    return this.readFile(path.join(this.dir, `${id}.json`));
  }

  appendMessage(sessionId: string, message: ChatMessage): void {
    const session = this.get(sessionId);
    if (!session) {
      throw new Error(`会话不存在：${sessionId}`);
    }
    session.messages.push(message);
    session.updatedAt = new Date().toISOString();

    if (
      message.role === "user" &&
      session.messages.filter((m) => m.role === "user").length === 1
    ) {
      session.title = truncateTitle(message.content);
    }

    this.write(session);
  }

  /** 整表替换消息并一次落盘（用于上下文压缩） */
  replaceMessages(sessionId: string, messages: ChatMessage[]): void {
    const session = this.get(sessionId);
    if (!session) {
      throw new Error(`会话不存在：${sessionId}`);
    }
    session.messages = messages;
    session.updatedAt = new Date().toISOString();
    this.write(session);
  }

  toolResultDir(sessionId: string): string {
    return path.join(this.dir, sessionId, "tool-results");
  }

  /** 写入工具结果全文，返回绝对路径 */
  writeToolResult(sessionId: string, resultId: string, content: string): string {
    const dir = this.toolResultDir(sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${resultId}.txt`);
    fs.writeFileSync(filePath, content, "utf8");
    return filePath;
  }

  updateTitle(sessionId: string, title: string): void {
    const session = this.get(sessionId);
    if (!session) {
      throw new Error(`会话不存在：${sessionId}`);
    }
    session.title = title;
    session.updatedAt = new Date().toISOString();
    this.write(session);
  }

  private write(session: Session): void {
    // 只序列化会话字段，绝不写入 api_key
    const payload: Session = {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messages: session.messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        ...(m.thinkingSummary ? { thinkingSummary: m.thinkingSummary } : {}),
        ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
        ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
        ...(m.toolName ? { toolName: m.toolName } : {}),
        ...(m.isError !== undefined ? { isError: m.isError } : {}),
        createdAt: m.createdAt,
      })),
    };
    fs.writeFileSync(
      path.join(this.dir, `${session.id}.json`),
      JSON.stringify(payload, null, 2),
      "utf8",
    );
  }

  private readFile(filePath: string): Session | null {
    if (!fs.existsSync(filePath)) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Session;
      if (!raw.id || !Array.isArray(raw.messages)) return null;
      return raw;
    } catch {
      return null;
    }
  }
}

function truncateTitle(text: string, max = 40): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t || "新会话";
  return `${t.slice(0, max)}…`;
}
