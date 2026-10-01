import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { parse as parseYaml } from "yaml";
import { projectAgentsDir, userAgentsDir } from "../config/paths.js";
import type { PermissionMode } from "../permission/types.js";
import {
  AgentFatalError,
  type AgentRecord,
  type AgentScope,
  type AgentWarning,
} from "./types.js";

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PERMISSIONS = new Set<PermissionMode>(["strict", "default", "allow"]);

export function builtinAgentsDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "builtin");
}

/** 三级角色目录：项目覆盖用户，用户覆盖内置。 */
export class AgentCatalog {
  private records = new Map<string, AgentRecord>();
  private warnList: AgentWarning[] = [];

  constructor(
    private readonly workspaceRoot: string,
    private readonly homeDir: string = os.homedir(),
  ) {}

  refresh(toolNames: ReadonlySet<string>): void {
    const layers: Array<{ scope: AgentScope; dir: string }> = [
      { scope: "builtin", dir: builtinAgentsDir() },
      { scope: "user", dir: userAgentsDir(this.homeDir) },
      { scope: "project", dir: projectAgentsDir(this.workspaceRoot) },
    ];
    const merged = new Map<string, AgentRecord>();
    const warnings: AgentWarning[] = [];
    for (const layer of layers) {
      const found = readDir(layer.dir, layer.scope, toolNames);
      warnings.push(...found.warnings);
      for (const record of found.records) {
        merged.set(record.name, record);
      }
    }
    this.records = merged;
    this.warnList = warnings;
  }

  get(name: string): AgentRecord | undefined {
    return this.records.get(name.toLowerCase());
  }

  /** 只有名字和用途。没有角色时为空串。 */
  catalogText(): string {
    const list = [...this.records.values()];
    if (list.length === 0) return "";
    const lines = ["可用角色："];
    for (const record of list) {
      lines.push(
        record.description
          ? `- ${record.name}：${record.description}`
          : `- ${record.name}`,
      );
    }
    return lines.join("\n");
  }

  warnings(): AgentWarning[] {
    return this.warnList;
  }
}

function readDir(
  dir: string,
  scope: AgentScope,
  toolNames: ReadonlySet<string>,
): { records: AgentRecord[]; warnings: AgentWarning[] } {
  if (!fs.existsSync(dir)) return { records: [], warnings: [] };
  const names = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".md") && !name.startsWith("."));
  const records: AgentRecord[] = [];
  const warnings: AgentWarning[] = [];
  const seen = new Set<string>();
  for (const fileName of names) {
    const filePath = path.join(dir, fileName);
    if (!fs.statSync(filePath).isFile()) continue;
    const parsed = parseAgentFile(filePath, scope, toolNames);
    if ("warning" in parsed) {
      warnings.push(parsed.warning);
      continue;
    }
    if (seen.has(parsed.record.name)) {
      const scopeLabel =
        scope === "project" ? "项目级" : scope === "user" ? "用户级" : "内置";
      throw new AgentFatalError(
        parsed.record.name,
        `在${scopeLabel}重复`,
      );
    }
    seen.add(parsed.record.name);
    records.push(parsed.record);
  }
  return { records, warnings };
}

function parseAgentFile(
  filePath: string,
  scope: AgentScope,
  toolNames: ReadonlySet<string>,
): { record: AgentRecord } | { warning: AgentWarning } {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    return {
      warning: {
        path: filePath,
        reason: `无法读取：${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!text.startsWith("---")) {
    return { warning: { path: filePath, reason: "缺少元信息" } };
  }
  const end = text.indexOf("\n---", 3);
  if (end === -1) {
    return { warning: { path: filePath, reason: "元信息没有结束" } };
  }
  const yaml = text.slice(3, end).replace(/^\n/, "");
  const body = text.slice(end + 4).replace(/^\n/, "").trim();
  if (!body) {
    return { warning: { path: filePath, reason: "正文为空" } };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(yaml);
  } catch (err) {
    return {
      warning: {
        path: filePath,
        reason: `元信息无法解析：${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { warning: { path: filePath, reason: "元信息必须是对象" } };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.name !== "string" || obj.name.trim() === "") {
    return { warning: { path: filePath, reason: "缺少名字" } };
  }
  const name = obj.name.trim().toLowerCase();
  if (!NAME_RE.test(name)) {
    return { warning: { path: filePath, reason: `名字不合法：${obj.name}` } };
  }

  let description: string | undefined;
  if (obj.description !== undefined) {
    if (typeof obj.description !== "string" || obj.description.trim() === "") {
      return { warning: { path: filePath, reason: "用途说明不合法" } };
    }
    description = obj.description.trim();
  }

  const tools = parseNameList(obj.tools, filePath, "tools");
  if ("warning" in tools) return tools;
  const disallowed = parseNameList(obj.disallowedTools, filePath, "disallowedTools");
  if ("warning" in disallowed) return disallowed;

  for (const tool of [...(tools.list ?? []), ...(disallowed.list ?? [])]) {
    if (!toolNames.has(tool)) {
      throw new AgentFatalError(name, "名单中的工具不存在", tool);
    }
  }

  let model: string | undefined;
  if (obj.model !== undefined) {
    if (typeof obj.model !== "string" || obj.model.trim() === "") {
      return { warning: { path: filePath, reason: "模型不合法" } };
    }
    model = obj.model.trim();
  }

  let maxTurns: number | undefined;
  if (obj.maxTurns !== undefined) {
    if (
      typeof obj.maxTurns !== "number" ||
      !Number.isInteger(obj.maxTurns) ||
      obj.maxTurns <= 0
    ) {
      return { warning: { path: filePath, reason: "最大轮次必须是正整数" } };
    }
    maxTurns = obj.maxTurns;
  }

  let permission: PermissionMode | undefined;
  if (obj.permission !== undefined) {
    if (typeof obj.permission !== "string" || !PERMISSIONS.has(obj.permission as PermissionMode)) {
      return { warning: { path: filePath, reason: "权限档位不合法" } };
    }
    permission = obj.permission as PermissionMode;
  }

  let isolation: "worktree" | undefined;
  if (obj.isolation !== undefined) {
    if (obj.isolation !== "worktree") {
      return { warning: { path: filePath, reason: "isolation 不合法" } };
    }
    isolation = "worktree";
  }

  return {
    record: {
      name,
      ...(description ? { description } : {}),
      ...(tools.list !== undefined ? { tools: tools.list } : {}),
      ...(disallowed.list !== undefined ? { disallowedTools: disallowed.list } : {}),
      ...(model ? { model } : {}),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      ...(permission ? { permission } : {}),
      ...(isolation ? { isolation } : {}),
      body,
      scope,
      path: filePath,
    },
  };
}

function parseNameList(
  value: unknown,
  filePath: string,
  field: string,
): { list?: string[] } | { warning: AgentWarning } {
  if (value === undefined) return {};
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    return { warning: { path: filePath, reason: `${field} 必须是非空字符串数组` } };
  }
  return { list: value.map((item) => (item as string).trim()) };
}
