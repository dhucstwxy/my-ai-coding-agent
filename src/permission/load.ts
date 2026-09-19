import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { PermissionEffect, PermissionRule, PermissionSource, RuleSet } from "./types.js";

const BUILTIN_TOOL_NAMES = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "run_command",
  "glob_files",
  "grep_search",
]);

function isAllowedToolName(name: string): boolean {
  if (BUILTIN_TOOL_NAMES.has(name)) return true;
  const sep = name.indexOf("__");
  if (sep <= 0) return false;
  return name.slice(sep + 2).length > 0;
}

const EFFECTS = new Set<PermissionEffect>(["allow", "ask", "deny"]);

export function permissionFilePaths(workspaceRoot: string): {
  user: string;
  project: string;
  local: string;
} {
  return {
    user: path.join(os.homedir(), ".mewcode", "permissions.yaml"),
    project: path.join(workspaceRoot, ".mewcode", "permissions.yaml"),
    local: path.join(workspaceRoot, ".mewcode", "permissions.local.yaml"),
  };
}

/** 读取用户级、项目级、本地级规则。文件不存在视为空。坏条目跳过并写入 warnings。 */
export function loadPermissionRules(workspaceRoot: string): RuleSet {
  const paths = permissionFilePaths(workspaceRoot);
  const warnings: string[] = [];
  const rules = [
    ...readFile(paths.user, "user", warnings),
    ...readFile(paths.project, "project", warnings),
    ...readFile(paths.local, "local", warnings),
  ];
  return { rules, warnings };
}

function readFile(
  filePath: string,
  source: PermissionSource,
  warnings: string[],
): PermissionRule[] {
  if (!fs.existsSync(filePath)) return [];

  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    warnings.push(
      `无法读取权限文件 ${filePath}：${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }

  if (text.trim() === "") return [];

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    warnings.push(
      `权限文件无法解析 ${filePath}：${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }

  if (raw == null) return [];
  if (!isRulesDocument(raw)) {
    warnings.push(`权限文件缺少 rules 数组，已忽略：${filePath}`);
    return [];
  }

  const rules: PermissionRule[] = [];
  raw.rules.forEach((entry, index) => {
    const parsed = parseEntry(entry);
    if (!parsed) {
      warnings.push(`已跳过 ${filePath} 第 ${index + 1} 条：字段不合法`);
      return;
    }
    rules.push({ ...parsed, source });
  });
  return rules;
}

function isRulesDocument(value: unknown): value is { rules: unknown[] } {
  if (typeof value !== "object" || value === null) return false;
  return Array.isArray((value as { rules?: unknown }).rules);
}

function parseEntry(
  entry: unknown,
): { tool: string; pattern: string; effect: PermissionEffect } | null {
  if (typeof entry !== "object" || entry === null) return null;
  const record = entry as Record<string, unknown>;
  if (typeof record.tool !== "string" || !isAllowedToolName(record.tool)) return null;
  if (typeof record.pattern !== "string" || record.pattern.trim() === "") return null;
  if (typeof record.effect !== "string" || !EFFECTS.has(record.effect as PermissionEffect)) {
    return null;
  }
  return {
    tool: record.tool,
    pattern: record.pattern,
    effect: record.effect as PermissionEffect,
  };
}
