import fs from "node:fs";
import path from "node:path";
import { parseSkillFile } from "./parse.js";
import type { SkillRecord, SkillScope, SkillWarning } from "./types.js";

export interface DiscoverResult {
  records: SkillRecord[];
  warnings: SkillWarning[];
}

/** 只扫描一层：根上的 md，以及含 SKILL.md 的子目录 */
export function discoverScope(dir: string, scope: SkillScope): DiscoverResult {
  if (!fs.existsSync(dir)) {
    return { records: [], warnings: [] };
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return {
      records: [],
      warnings: [
        {
          path: dir,
          reason: `无法读取目录：${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }

  const records: SkillRecord[] = [];
  const warnings: SkillWarning[] = [];

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      const parsed = parseSkillFile(full, scope);
      if ("warning" in parsed) warnings.push(parsed.warning);
      else records.push(parsed.record);
      continue;
    }
    if (!entry.isDirectory()) continue;
    const entryFile = path.join(full, "SKILL.md");
    if (!fs.existsSync(entryFile)) continue;
    const parsed = parseSkillFile(entryFile, scope);
    if ("warning" in parsed) {
      warnings.push(parsed.warning);
      continue;
    }
    const companions = listCompanionFiles(full, entryFile);
    records.push({
      ...parsed.record,
      packageDir: full,
      companions,
    });
  }

  return { records, warnings };
}

function listCompanionFiles(packageDir: string, entryFile: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.isFile() && path.resolve(full) !== path.resolve(entryFile)) {
        out.push(full);
      }
    }
  };
  walk(packageDir);
  return out.sort();
}
