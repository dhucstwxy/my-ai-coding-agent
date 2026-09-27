import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { projectSkillsDir, userSkillsDir } from "../config/paths.js";
import { discoverScope } from "./discover.js";
import { SkillFatalError, type SkillRecord, type SkillWarning } from "./types.js";

export function builtinSkillsDir(): string {
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "builtin",
  );
}

/** 三级 Skill 目录：项目覆盖用户，用户覆盖内置 */
export class SkillCatalog {
  private records = new Map<string, SkillRecord>();
  private warnList: SkillWarning[] = [];

  constructor(
    private readonly workspaceRoot: string,
    private readonly homeDir: string = os.homedir(),
  ) {}

  refresh(toolNames: ReadonlySet<string>): void {
    const layers = [
      { scope: "builtin" as const, dir: builtinSkillsDir() },
      { scope: "user" as const, dir: userSkillsDir(this.homeDir) },
      { scope: "project" as const, dir: projectSkillsDir(this.workspaceRoot) },
    ];

    const warnings: SkillWarning[] = [];
    const merged = new Map<string, SkillRecord>();

    for (const layer of layers) {
      const found = discoverScope(layer.dir, layer.scope);
      warnings.push(...found.warnings);
      const seen = new Set<string>();
      for (const rec of found.records) {
        if (seen.has(rec.name)) {
          throw new SkillFatalError(
            "duplicate_name",
            rec.name,
            layer.scope,
          );
        }
        seen.add(rec.name);
      }
      for (const rec of found.records) {
        merged.set(rec.name, rec);
      }
    }

    for (const rec of merged.values()) {
      for (const tool of rec.tools ?? []) {
        if (tool === "load_skill") continue;
        if (!toolNames.has(tool)) {
          throw new SkillFatalError(
            "unknown_tool",
            rec.name,
            rec.scope,
            tool,
          );
        }
      }
    }

    this.records = merged;
    this.warnList = warnings;
  }

  list(): SkillRecord[] {
    return [...this.records.values()];
  }

  get(name: string): SkillRecord | undefined {
    return this.records.get(name.toLowerCase());
  }

  warnings(): SkillWarning[] {
    return [...this.warnList];
  }

  /** 只有名字和一句话说明 */
  catalogText(): string {
    const lines = this.list().map(
      (s) => `- ${s.name}：${s.description}`,
    );
    if (lines.length === 0) return "";
    return ["可用 Skill（只有名字和说明，完整步骤需加载）：", ...lines].join(
      "\n",
    );
  }
}
