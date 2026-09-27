import type { CommandDefinition } from "./types.js";

/** 主名或别名冲突 */
export class CommandConflictError extends Error {
  readonly conflictName: string;

  constructor(conflictName: string) {
    super(`命令名称或别名冲突：${conflictName}`);
    this.name = "CommandConflictError";
    this.conflictName = conflictName;
  }
}

export class CommandRegistry {
  private readonly byName = new Map<string, CommandDefinition>();

  register(def: CommandDefinition): void {
    const keys = [def.name, ...(def.aliases ?? [])].map((k) =>
      k.toLowerCase(),
    );
    for (const key of keys) {
      if (this.byName.has(key)) {
        throw new CommandConflictError(key);
      }
    }
    for (const key of keys) {
      this.byName.set(key, def);
    }
  }

  get(name: string): CommandDefinition | undefined {
    return this.byName.get(name.toLowerCase());
  }

  /** 可见命令（去重，按主名） */
  listVisible(): CommandDefinition[] {
    const seen = new Set<CommandDefinition>();
    const out: CommandDefinition[] = [];
    for (const def of this.byName.values()) {
      if (def.hidden || seen.has(def)) continue;
      seen.add(def);
      out.push(def);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 含别名，供补全；排除 hidden */
  allNames(): string[] {
    const names = new Set<string>();
    for (const [key, def] of this.byName) {
      if (def.hidden) continue;
      names.add(key);
    }
    return [...names].sort();
  }
}
