import fs from "node:fs";
import { parse as parseYaml } from "yaml";
import type { SkillMode, SkillRecord, SkillScope, SkillWarning } from "./types.js";

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function parseSkillFile(
  filePath: string,
  scope: SkillScope,
): { record: SkillRecord } | { warning: SkillWarning } {
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
  return parseSkillText(raw, filePath, scope);
}

export function parseSkillText(
  raw: string,
  filePath: string,
  scope: SkillScope,
): { record: SkillRecord } | { warning: SkillWarning } {
  const split = splitFrontmatter(raw);
  if (!split) {
    return { warning: { path: filePath, reason: "缺少 frontmatter" } };
  }

  let data: unknown;
  try {
    data = parseYaml(split.yaml);
  } catch (err) {
    return {
      warning: {
        path: filePath,
        reason: `frontmatter 无法解析：${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { warning: { path: filePath, reason: "frontmatter 必须是映射" } };
  }
  const obj = data as Record<string, unknown>;

  const nameRaw = obj.name;
  if (typeof nameRaw !== "string" || !nameRaw.trim()) {
    return { warning: { path: filePath, reason: "缺少名字" } };
  }
  const name = nameRaw.trim().toLowerCase();
  if (!NAME_RE.test(name)) {
    return { warning: { path: filePath, reason: `名字不合法：${name}` } };
  }

  const description = obj.description;
  if (typeof description !== "string" || !description.trim()) {
    return { warning: { path: filePath, reason: "缺少一句话说明" } };
  }

  let tools: string[] | undefined;
  if ("tools" in obj && obj.tools !== undefined && obj.tools !== null) {
    if (!Array.isArray(obj.tools) || obj.tools.some((t) => typeof t !== "string")) {
      return { warning: { path: filePath, reason: "白名单必须是字符串数组" } };
    }
    tools = obj.tools;
  }

  let mode: SkillMode = "shared";
  if (obj.mode !== undefined && obj.mode !== null) {
    if (obj.mode !== "shared" && obj.mode !== "isolated") {
      return { warning: { path: filePath, reason: `执行模式不合法：${String(obj.mode)}` } };
    }
    mode = obj.mode;
  }

  let history = 0;
  if (obj.history !== undefined && obj.history !== null) {
    if (typeof obj.history !== "number" || !Number.isFinite(obj.history)) {
      return { warning: { path: filePath, reason: "历史条数必须是数字" } };
    }
    if (obj.history < 0) {
      return { warning: { path: filePath, reason: "历史条数为负" } };
    }
    history = obj.history;
  }

  let model: string | undefined;
  if (typeof obj.model === "string" && obj.model.trim()) {
    model = obj.model.trim();
  }

  const record: SkillRecord = {
    name,
    description: description.trim(),
    ...(tools !== undefined ? { tools } : {}),
    mode,
    history,
    ...(model ? { model } : {}),
    body: split.body,
    scope,
    entryPath: filePath,
    companions: [],
  };
  return { record };
}

function splitFrontmatter(
  raw: string,
): { yaml: string; body: string } | null {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return null;
  const yaml = text.slice(3, end).replace(/^\r?\n/, "");
  let body = text.slice(end + 4);
  body = body.replace(/^\r?\n/, "");
  return { yaml, body };
}
