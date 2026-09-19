import { JsonRpcPeer } from "./jsonrpc.js";
import {
  MCP_PROTOCOL_VERSION,
  type McpListedTool,
  type McpServerConfig,
  type McpTransport,
} from "./types.js";

export interface McpCallResult {
  ok: boolean;
  content: string;
}

export interface McpSession {
  readonly name: string;
  readonly tools: McpListedTool[];
  callTool(
    toolName: string,
    args: unknown,
    timeoutMs: number,
  ): Promise<McpCallResult>;
  close(): Promise<void>;
}

/**
 * 完成握手与分页列出工具，之后按需 tools/call。
 */
export async function openMcpSession(
  config: McpServerConfig,
  transport: McpTransport,
  handshakeMs: number,
): Promise<McpSession> {
  const peer = new JsonRpcPeer(transport);
  const deadline = Date.now() + handshakeMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  try {
    const init = (await peer.request(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "MewCode", version: "1.0.0" },
      },
      remaining(),
    )) as { protocolVersion?: string };

    if (init?.protocolVersion !== MCP_PROTOCOL_VERSION) {
      throw new Error(
        `协议版本谈不拢：期望 ${MCP_PROTOCOL_VERSION}，收到 ${String(init?.protocolVersion)}`,
      );
    }

    await peer.notify("notifications/initialized");

    const tools: McpListedTool[] = [];
    let cursor: string | undefined;
    do {
      const listed = (await peer.request(
        "tools/list",
        cursor === undefined ? {} : { cursor },
        remaining(),
      )) as {
        tools?: unknown[];
        nextCursor?: string;
      };
      for (const item of listed.tools ?? []) {
        const tool = normalizeTool(item);
        if (tool) tools.push(tool);
      }
      cursor =
        typeof listed.nextCursor === "string" && listed.nextCursor.length > 0
          ? listed.nextCursor
          : undefined;
    } while (cursor);

    return {
      name: config.name,
      tools,
      async callTool(toolName, args, timeoutMs) {
        try {
          const result = (await peer.request(
            "tools/call",
            { name: toolName, arguments: args ?? {} },
            timeoutMs,
          )) as {
            content?: unknown[];
            isError?: boolean;
          };
          const text = extractText(result.content);
          const content =
            text.length > 0 ? text : "远端没有返回文本";
          return {
            ok: result.isError !== true,
            content,
          };
        } catch (err) {
          return {
            ok: false,
            content: `MCP 调用失败：${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
      async close() {
        await peer.close();
      },
    };
  } catch (err) {
    await peer.close().catch(() => undefined);
    throw err;
  }
}

function normalizeTool(item: unknown): McpListedTool | null {
  if (typeof item !== "object" || item === null) return null;
  const record = item as Record<string, unknown>;
  if (typeof record.name !== "string" || record.name.trim() === "") return null;
  const description =
    typeof record.description === "string" ? record.description : "";
  const inputSchema =
    typeof record.inputSchema === "object" &&
    record.inputSchema !== null &&
    !Array.isArray(record.inputSchema)
      ? (record.inputSchema as Record<string, unknown>)
      : { type: "object" };
  return { name: record.name, description, inputSchema };
}

function extractText(content: unknown[] | undefined): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const record = block as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      parts.push(record.text);
    }
  }
  return parts.join("\n");
}
