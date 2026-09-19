/** MCP 客户端类型与常量 */

export const MCP_PROTOCOL_VERSION = "2025-11-25";
export const MCP_HANDSHAKE_TIMEOUT_MS = 15_000;

export type McpServerConfig =
  | {
      name: string;
      type: "stdio";
      command: string;
      args: string[];
      env: Record<string, string>;
    }
  | {
      name: string;
      type: "http";
      url: string;
      headers: Record<string, string>;
    };

export interface McpLoadResult {
  servers: McpServerConfig[];
  warnings: string[];
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: number;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: number;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccess
  | JsonRpcFailure;

export interface McpTransport {
  send(message: JsonRpcMessage): Promise<void>;
  onMessage(handler: (message: JsonRpcMessage) => void): void;
  close(): Promise<void>;
}

export interface McpListedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
