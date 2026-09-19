import fs from "node:fs";
import { parse as parseYaml } from "yaml";
import { projectConfigPath, userConfigPath } from "../config/paths.js";
import type { McpLoadResult, McpServerConfig } from "./types.js";

const SERVER_NAME_RE = /^[A-Za-z0-9]+(?:[_-][A-Za-z0-9]+)*$/;
const ENV_VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * 读取用户级与项目级配置中的 mcp_servers。
 * 同名键由项目级整段覆盖。不改动供应商配置的读取。
 */
export function loadMcpServers(
  workspaceRoot: string,
  paths?: { user?: string; project?: string },
): McpLoadResult {
  const warnings: string[] = [];
  const userMap = readMcpMap(paths?.user ?? userConfigPath(), warnings);
  const projectMap = readMcpMap(
    paths?.project ?? projectConfigPath(workspaceRoot),
    warnings,
  );

  const merged = new Map<string, unknown>();
  for (const [name, value] of Object.entries(userMap)) {
    merged.set(name, value);
  }
  for (const [name, value] of Object.entries(projectMap)) {
    merged.set(name, value);
  }

  const servers: McpServerConfig[] = [];
  for (const [name, raw] of merged) {
    const parsed = parseServer(name, raw, warnings);
    if (parsed) servers.push(parsed);
  }
  return { servers, warnings };
}

function readMcpMap(
  filePath: string,
  warnings: string[],
): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    warnings.push(
      `无法读取 MCP 配置 ${filePath}：${err instanceof Error ? err.message : String(err)}`,
    );
    return {};
  }
  if (text.trim() === "") return {};

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    warnings.push(
      `MCP 配置无法解析 ${filePath}：${err instanceof Error ? err.message : String(err)}`,
    );
    return {};
  }
  if (typeof raw !== "object" || raw === null) return {};
  const mcp = (raw as { mcp_servers?: unknown }).mcp_servers;
  if (mcp === undefined) return {};
  if (typeof mcp !== "object" || mcp === null || Array.isArray(mcp)) {
    warnings.push(`mcp_servers 必须是对象，已忽略：${filePath}`);
    return {};
  }
  return mcp as Record<string, unknown>;
}

function parseServer(
  name: string,
  raw: unknown,
  warnings: string[],
): McpServerConfig | null {
  if (!SERVER_NAME_RE.test(name)) {
    warnings.push(`已跳过 MCP Server「${name}」：名称不合法`);
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    warnings.push(`已跳过 MCP Server「${name}」：配置必须是对象`);
    return null;
  }
  const record = raw as Record<string, unknown>;
  const type = record.type;
  if (type !== "stdio" && type !== "http") {
    warnings.push(`已跳过 MCP Server「${name}」：type 必须是 stdio 或 http`);
    return null;
  }

  if (type === "stdio") {
    if (typeof record.command !== "string" || record.command.trim() === "") {
      warnings.push(`已跳过 MCP Server「${name}」：缺少 command`);
      return null;
    }
    let args: string[] = [];
    if (record.args !== undefined) {
      if (
        !Array.isArray(record.args) ||
        !record.args.every((item) => typeof item === "string")
      ) {
        warnings.push(`已跳过 MCP Server「${name}」：args 必须是字符串数组`);
        return null;
      }
      args = record.args as string[];
    }
    const envResult = expandStringMap(name, record.env, "env", warnings);
    if (!envResult) return null;
    return {
      name,
      type: "stdio",
      command: record.command,
      args,
      env: envResult,
    };
  }

  if (typeof record.url !== "string" || record.url.trim() === "") {
    warnings.push(`已跳过 MCP Server「${name}」：缺少 url`);
    return null;
  }
  const headersResult = expandStringMap(name, record.headers, "headers", warnings);
  if (!headersResult) return null;
  return {
    name,
    type: "http",
    url: record.url,
    headers: headersResult,
  };
}

function expandStringMap(
  serverName: string,
  raw: unknown,
  field: "env" | "headers",
  warnings: string[],
): Record<string, string> | null {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    warnings.push(`已跳过 MCP Server「${serverName}」：${field} 必须是对象`);
    return null;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "string") {
      warnings.push(
        `已跳过 MCP Server「${serverName}」：${field}.${key} 必须是字符串`,
      );
      return null;
    }
    const expanded = expandValue(serverName, value, warnings);
    if (expanded === null) return null;
    out[key] = expanded;
  }
  return out;
}

/** 只展开 ${VAR}。变量不存在时返回 null。 */
function expandValue(
  serverName: string,
  value: string,
  warnings: string[],
): string | null {
  let missing: string | null = null;
  const expanded = value.replace(ENV_VAR_RE, (_match, name: string) => {
    if (!(name in process.env) || process.env[name] === undefined) {
      missing = name;
      return "";
    }
    return process.env[name] as string;
  });
  if (missing) {
    warnings.push(
      `已跳过 MCP Server「${serverName}」：环境变量 ${missing} 不存在`,
    );
    return null;
  }
  return expanded;
}
