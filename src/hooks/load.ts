import fs from "node:fs";
import os from "node:os";
import { parse as parseYaml } from "yaml";
import {
  localHooksPath,
  projectHooksPath,
  userHooksPath,
} from "../config/paths.js";
import {
  HOOK_DEFAULT_TIMEOUT_MS,
  HookFatalError,
  type HookAction,
  type HookCondition,
  type HookEvent,
  type HookRule,
  type HookSource,
} from "./types.js";

const EVENTS = new Set<HookEvent>([
  "session_start",
  "session_end",
  "turn_start",
  "turn_end",
  "user_message",
  "assistant_message",
  "pre_tool",
  "post_tool",
  "compact",
]);

const TOOL_EVENTS = new Set<HookEvent>(["pre_tool", "post_tool"]);

export interface LoadHooksOptions {
  /** 测试时指向临时家目录。缺省为当前用户家目录 */
  homeDir?: string;
}

/**
 * 按用户、项目、本地的顺序加载规则。文件不存在视为空。
 * 任一条不合法抛 HookFatalError。
 */
export function loadHooks(
  workspaceRoot: string,
  options: LoadHooksOptions = {},
): HookRule[] {
  const home = options.homeDir ?? os.homedir();
  const files: Array<{ path: string; source: HookSource }> = [
    { path: userHooksPath(home), source: "user" },
    { path: projectHooksPath(workspaceRoot), source: "project" },
    { path: localHooksPath(workspaceRoot), source: "local" },
  ];
  const rules: HookRule[] = [];
  for (const file of files) {
    rules.push(...readFile(file.path, file.source));
  }
  return rules;
}

function readFile(filePath: string, source: HookSource): HookRule[] {
  if (!fs.existsSync(filePath)) return [];
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    throw new HookFatalError(
      filePath,
      `无法读取：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (text.trim() === "") return [];

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new HookFatalError(
      filePath,
      `无法解析：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (raw == null) return [];
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new HookFatalError(filePath, "根节点必须是包含 hooks 的对象");
  }
  const hooks = (raw as Record<string, unknown>).hooks;
  if (!Array.isArray(hooks)) {
    throw new HookFatalError(filePath, "缺少 hooks 数组");
  }
  return hooks.map((item, index) => parseRule(item, filePath, source, index));
}

function parseRule(
  item: unknown,
  filePath: string,
  source: HookSource,
  index: number,
): HookRule {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    throw new HookFatalError(filePath, `第 ${index + 1} 条规则不是对象`);
  }
  const rec = item as Record<string, unknown>;
  if (rec.event === undefined) {
    throw new HookFatalError(filePath, "缺少事件");
  }
  if (typeof rec.event !== "string" || !EVENTS.has(rec.event as HookEvent)) {
    throw new HookFatalError(filePath, `未知事件：${String(rec.event)}`);
  }
  const event = rec.event as HookEvent;

  if (rec.if !== undefined && !TOOL_EVENTS.has(event)) {
    throw new HookFatalError(filePath, "非工具事件不能写条件");
  }
  const parsedIf = rec.if === undefined ? undefined : parseIf(rec.if, filePath);

  if (rec.deny !== undefined && event !== "pre_tool") {
    throw new HookFatalError(filePath, "只有 pre_tool 可以写拒绝说明");
  }
  let denyMessage: string | undefined;
  if (rec.deny !== undefined) {
    if (typeof rec.deny !== "string" || rec.deny.trim() === "") {
      throw new HookFatalError(filePath, "拒绝说明必须是非空字符串");
    }
    denyMessage = rec.deny;
  }

  if (rec.action === undefined) {
    throw new HookFatalError(filePath, "缺少动作");
  }
  const action = parseAction(rec.action, filePath);
  const once = parseBool(rec.once, filePath, "once");
  const background = parseBool(rec.async, filePath, "async");
  if (background && (denyMessage || action.type === "prompt")) {
    throw new HookFatalError(filePath, "带拒绝说明或注入提示词时不能异步");
  }

  let timeoutMs = HOOK_DEFAULT_TIMEOUT_MS;
  if (rec.timeout_ms !== undefined) {
    if (
      typeof rec.timeout_ms !== "number" ||
      !Number.isFinite(rec.timeout_ms) ||
      rec.timeout_ms <= 0
    ) {
      throw new HookFatalError(filePath, "timeout_ms 必须是正数");
    }
    timeoutMs = rec.timeout_ms;
  }

  return {
    id: `${filePath}#${index}`,
    event,
    source,
    sourcePath: filePath,
    ...(parsedIf
      ? { conditions: parsedIf.conditions, match: parsedIf.match }
      : {}),
    ...(denyMessage ? { denyMessage } : {}),
    action,
    once,
    background,
    timeoutMs,
  };
}

function parseIf(
  raw: unknown,
  filePath: string,
): { match: "all" | "any"; conditions: HookCondition[] } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new HookFatalError(filePath, "if 必须是 all 或 any");
  }
  const obj = raw as Record<string, unknown>;
  const hasAll = Object.prototype.hasOwnProperty.call(obj, "all");
  const hasAny = Object.prototype.hasOwnProperty.call(obj, "any");
  if (hasAll && hasAny) {
    throw new HookFatalError(filePath, "if 不能同时包含 all 和 any");
  }
  if (!hasAll && !hasAny) {
    throw new HookFatalError(filePath, "if 缺少 all 或 any");
  }
  const match = hasAll ? "all" : "any";
  const list = obj[match];
  if (!Array.isArray(list) || list.length === 0) {
    throw new HookFatalError(filePath, "if 条件不能为空");
  }
  const conditions = list.map((entry, index) => parseCondition(entry, filePath, index));
  return { match, conditions };
}

function parseCondition(entry: unknown, filePath: string, index: number): HookCondition {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new HookFatalError(filePath, `第 ${index + 1} 个条件不是对象`);
  }
  const rec = entry as Record<string, unknown>;
  if (typeof rec.tool !== "string" || rec.tool.trim() === "") {
    throw new HookFatalError(filePath, `第 ${index + 1} 个条件缺少 tool`);
  }
  if (typeof rec.pattern !== "string" || rec.pattern.trim() === "") {
    throw new HookFatalError(filePath, `第 ${index + 1} 个条件缺少 pattern`);
  }
  return { tool: rec.tool, pattern: rec.pattern };
}

function parseAction(raw: unknown, filePath: string): HookAction {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new HookFatalError(filePath, "缺少动作");
  }
  const rec = raw as Record<string, unknown>;
  if (rec.type === "command") {
    if (typeof rec.command !== "string" || rec.command.trim() === "") {
      throw new HookFatalError(filePath, "动作缺少命令");
    }
    return { type: "command", command: rec.command };
  }
  if (rec.type === "prompt") {
    if (typeof rec.text !== "string" || rec.text.trim() === "") {
      throw new HookFatalError(filePath, "动作缺少文本");
    }
    return { type: "prompt", text: rec.text };
  }
  if (rec.type === "http") {
    if (typeof rec.url !== "string" || rec.url.trim() === "") {
      throw new HookFatalError(filePath, "动作缺少 URL");
    }
    let method = "GET";
    if (rec.method !== undefined) {
      if (typeof rec.method !== "string" || rec.method.trim() === "") {
        throw new HookFatalError(filePath, "HTTP 方法不合法");
      }
      method = rec.method;
    }
    const body =
      rec.body === undefined
        ? undefined
        : typeof rec.body === "string"
          ? rec.body
          : null;
    if (body === null) {
      throw new HookFatalError(filePath, "HTTP body 必须是字符串");
    }
    return { type: "http", url: rec.url, method, ...(body !== undefined ? { body } : {}) };
  }
  if (rec.type === "subagent") {
    if (typeof rec.name !== "string" || rec.name.trim() === "") {
      throw new HookFatalError(filePath, "动作缺少子 Agent 名字");
    }
    return { type: "subagent", name: rec.name };
  }
  throw new HookFatalError(filePath, `未知动作类型：${String(rec.type)}`);
}

function parseBool(value: unknown, filePath: string, field: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw new HookFatalError(filePath, `${field} 必须是布尔值`);
  }
  return value;
}
