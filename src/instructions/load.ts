import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { userMewcodeDir } from "../config/paths.js";
import { expandIncludes } from "./include.js";

export const INSTRUCTIONS_MAX_BYTES = 100_000;

export interface InstructionLoadResult {
  text: string;
  warnings: string[];
}

function readIfExists(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * 按优先级加载三层 AGENTS.md：项目根 > .mewcode > 用户级。
 */
export function loadInstructions(
  workspaceRoot: string,
  home = os.homedir(),
): InstructionLoadResult {
  const warnings: string[] = [];
  const parts: string[] = [];

  const layers: Array<{ file: string; root: string; label: string }> = [
    {
      file: path.join(workspaceRoot, "AGENTS.md"),
      root: workspaceRoot,
      label: "项目根",
    },
    {
      file: path.join(workspaceRoot, ".mewcode", "AGENTS.md"),
      root: workspaceRoot,
      label: "项目 .mewcode",
    },
    {
      file: path.join(userMewcodeDir(home), "AGENTS.md"),
      root: userMewcodeDir(home),
      label: "用户",
    },
  ];

  for (const layer of layers) {
    const raw = readIfExists(layer.file);
    if (raw === null) continue;
    const expanded = expandIncludes(raw, {
      rootDir: layer.root,
      visited: new Set<string>(),
    });
    for (const w of expanded.warnings) {
      warnings.push(`[${layer.label}] ${w}`);
    }
    const body = expanded.text.trim();
    if (body) parts.push(body);
  }

  let text = parts.join("\n\n");
  if (Buffer.byteLength(text, "utf8") > INSTRUCTIONS_MAX_BYTES) {
    warnings.push(
      `项目指令总长度超过 ${INSTRUCTIONS_MAX_BYTES} 字节，已截断`,
    );
    let cut = text;
    while (Buffer.byteLength(cut, "utf8") > INSTRUCTIONS_MAX_BYTES) {
      cut = cut.slice(0, Math.floor(cut.length * 0.9));
    }
    text = cut;
  }

  return { text, warnings };
}
