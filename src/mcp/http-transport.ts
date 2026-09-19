import type { JsonRpcMessage, McpServerConfig, McpTransport } from "./types.js";

/**
 * Streamable HTTP：POST 单条消息，接受 JSON 或 SSE 回包。
 */
export function createHttpTransport(
  config: Extract<McpServerConfig, { type: "http" }>,
): McpTransport {
  let handler: ((message: JsonRpcMessage) => void) | null = null;
  let sessionId: string | null = null;
  let closed = false;

  return {
    async send(message) {
      if (closed) throw new Error("HTTP 传输已关闭");

      const headers: Record<string, string> = {
        ...config.headers,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      };
      if (sessionId) {
        headers["Mcp-Session-Id"] = sessionId;
      }

      let response: Response;
      try {
        response = await fetch(config.url, {
          method: "POST",
          headers,
          body: JSON.stringify(message),
        });
      } catch (err) {
        throw new Error(
          `MCP HTTP 请求失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const responseSession = response.headers.get("mcp-session-id");
      if (responseSession) sessionId = responseSession;

      if (response.status === 202) return;

      const contentType = response.headers.get("content-type") ?? "";
      if (!response.ok && response.status !== 200) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `MCP HTTP ${response.status}${body ? `：${body.slice(0, 200)}` : ""}`,
        );
      }

      if (contentType.includes("text/event-stream")) {
        await readSse(response, message, handler);
        return;
      }

      if (contentType.includes("application/json") || contentType === "") {
        const text = await response.text();
        if (text.trim() === "") return;
        try {
          const parsed = JSON.parse(text) as JsonRpcMessage;
          handler?.(parsed);
        } catch {
          throw new Error("MCP HTTP 回包不是合法 JSON");
        }
        return;
      }

      throw new Error(`不支持的 MCP Content-Type：${contentType}`);
    },
    onMessage(next) {
      handler = next;
    },
    async close() {
      if (closed) return;
      closed = true;
      handler = null;
      if (!sessionId) return;
      try {
        await fetch(config.url, {
          method: "DELETE",
          headers: {
            ...config.headers,
            "Mcp-Session-Id": sessionId,
          },
        });
      } catch {
        /* 删除会话失败时忽略 */
      }
      sessionId = null;
    },
  };
}

async function readSse(
  response: Response,
  sent: JsonRpcMessage,
  handler: ((message: JsonRpcMessage) => void) | null,
): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const wantId = "id" in sent ? sent.id : undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const dataLines = part
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart());
      if (dataLines.length === 0) continue;
      const data = dataLines.join("\n");
      try {
        const parsed = JSON.parse(data) as JsonRpcMessage;
        handler?.(parsed);
        if (
          wantId !== undefined &&
          "id" in parsed &&
          parsed.id === wantId
        ) {
          await reader.cancel().catch(() => undefined);
          return;
        }
      } catch {
        /* 忽略坏事件 */
      }
    }
  }
}
