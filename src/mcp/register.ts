import type { ToolRegistry } from "../tools/registry.js";
import type { Tool } from "../tools/types.js";
import { loadMcpServers } from "./config.js";
import { createHttpTransport } from "./http-transport.js";
import { openMcpSession, type McpSession } from "./session.js";
import { createStdioTransport } from "./stdio-transport.js";
import {
  MCP_HANDSHAKE_TIMEOUT_MS,
  type McpServerConfig,
} from "./types.js";

const BUILTIN_TOOLS = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "run_command",
  "glob_files",
  "grep_search",
]);

export interface ConnectMcpResult {
  warnings: string[];
  close: () => Promise<void>;
}

/**
 * 并行连接各 Server，把远端工具注册进现有工具中心。
 * 单个失败只产生警告。
 */
export async function connectMcpServers(
  workspaceRoot: string,
  registry: ToolRegistry,
): Promise<ConnectMcpResult> {
  const loaded = loadMcpServers(workspaceRoot);
  const warnings = [...loaded.warnings];
  const sessions: McpSession[] = [];
  let closed = false;

  await Promise.all(
    loaded.servers.map(async (config) => {
      try {
        const session = await connectOne(config, workspaceRoot);
        sessions.push(session);
        for (const tool of session.tools) {
          const registered = `${config.name}__${tool.name}`;
          if (BUILTIN_TOOLS.has(registered) || BUILTIN_TOOLS.has(tool.name)) {
            warnings.push(
              `已跳过 MCP 工具「${registered}」：与内置工具同名`,
            );
            continue;
          }
          if (!tool.name.trim()) {
            warnings.push(
              `已跳过 MCP Server「${config.name}」中的空工具名`,
            );
            continue;
          }
          registry.register(
            wrapTool(registered, tool.description, tool.inputSchema, session, tool.name),
          );
        }
      } catch (err) {
        warnings.push(
          `MCP Server「${config.name}」连接失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),
  );

  return {
    warnings,
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all(
        sessions.map((session) => session.close().catch(() => undefined)),
      );
    },
  };
}

async function connectOne(
  config: McpServerConfig,
  workspaceRoot: string,
): Promise<McpSession> {
  const transport =
    config.type === "stdio"
      ? createStdioTransport(config, workspaceRoot)
      : createHttpTransport(config);
  return openMcpSession(config, transport, MCP_HANDSHAKE_TIMEOUT_MS);
}

function wrapTool(
  registeredName: string,
  description: string,
  inputSchema: Record<string, unknown>,
  session: McpSession,
  remoteName: string,
): Tool {
  return {
    name: registeredName,
    description,
    inputSchema,
    sideEffect: true,
    async execute(args, ctx) {
      const result = await session.callTool(
        remoteName,
        args,
        ctx.timeoutMs,
      );
      return {
        ok: result.ok,
        content: result.content,
        ...(result.ok ? {} : { errorCode: "mcp_error" }),
      };
    },
  };
}
