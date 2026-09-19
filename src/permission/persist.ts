import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { permissionFilePaths } from "./load.js";

export type PersistResult = { ok: true } | { ok: false; message: string };

interface StoredRule {
  tool: string;
  pattern: string;
  effect: string;
}

/**
 * 追加一条精确 allow 到本地级规则。解析失败时不覆盖原文件。
 */
export function appendLocalAllow(
  workspaceRoot: string,
  tool: string,
  pattern: string,
): PersistResult {
  const filePath = permissionFilePaths(workspaceRoot).local;
  let rules: StoredRule[] = [];

  if (fs.existsSync(filePath)) {
    let text: string;
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch (err) {
      return {
        ok: false,
        message: `无法读取本地权限文件：${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (text.trim() !== "") {
      let raw: unknown;
      try {
        raw = parseYaml(text);
      } catch (err) {
        return {
          ok: false,
          message: `本地权限文件无法解析，未写入：${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (raw != null) {
        if (typeof raw !== "object" || !Array.isArray((raw as { rules?: unknown }).rules)) {
          return { ok: false, message: "本地权限文件格式无法识别，未写入" };
        }
        rules = ((raw as { rules: unknown[] }).rules ?? []).map(toStoredRule);
      }
    }
  }

  rules.push({ tool, pattern, effect: "allow" });

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, stringifyYaml({ rules }), "utf8");
  } catch (err) {
    return {
      ok: false,
      message: `无法写入本地权限文件：${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { ok: true };
}

function toStoredRule(entry: unknown): StoredRule {
  if (typeof entry !== "object" || entry === null) {
    return { tool: "", pattern: "", effect: "" };
  }
  const record = entry as Record<string, unknown>;
  return {
    tool: typeof record.tool === "string" ? record.tool : "",
    pattern: typeof record.pattern === "string" ? record.pattern : "",
    effect: typeof record.effect === "string" ? record.effect : "",
  };
}
