import type {
  JsonRpcFailure,
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcSuccess,
  McpTransport,
} from "./types.js";

interface Pending {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * 在单个传输上按编号配对 JSON-RPC 请求与回包。
 */
export class JsonRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;

  constructor(private readonly transport: McpTransport) {
    this.transport.onMessage((message) => this.handleMessage(message));
  }

  async request(
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    if (this.closed) {
      throw new Error("MCP 连接已关闭");
    }
    const id = this.nextId++;
    const message: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    };

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 请求超时（${timeoutMs}ms）：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      void this.transport.send(message).catch((err) => {
        const waiting = this.pending.get(id);
        if (!waiting) return;
        clearTimeout(waiting.timer);
        this.pending.delete(id);
        waiting.reject(
          err instanceof Error ? err : new Error(String(err)),
        );
      });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.closed) {
      throw new Error("MCP 连接已关闭");
    }
    await this.transport.send({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const [id, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error("MCP 连接已关闭"));
      this.pending.delete(id);
    }
    await this.transport.close();
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (this.closed) return;

    if ("method" in message && "id" in message && message.id !== undefined) {
      const failure: JsonRpcFailure = {
        jsonrpc: "2.0",
        id: message.id as number,
        error: { code: -32601, message: "Method not found" },
      };
      void this.transport.send(failure).catch(() => {
        /* 回复失败时忽略 */
      });
      return;
    }

    if (!("id" in message) || message.id === undefined) {
      return;
    }

    const id = message.id as number;
    const waiting = this.pending.get(id);
    if (!waiting) return;
    clearTimeout(waiting.timer);
    this.pending.delete(id);

    if ("error" in message && message.error) {
      const err = message as JsonRpcFailure;
      waiting.reject(
        new Error(`MCP 错误 ${err.error.code}：${err.error.message}`),
      );
      return;
    }
    if ("result" in message) {
      waiting.resolve((message as JsonRpcSuccess).result);
    }
  }
}
