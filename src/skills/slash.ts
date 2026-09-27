import type { CommandRegistry } from "../commands/registry.js";
import type { SkillCatalog } from "./catalog.js";
import type { SkillRun } from "./types.js";

/** 会话控制命令，Skill 不能抢走 */
export const RESERVED_SKILL_COMMANDS = [
  "clear",
  "help",
  "plan",
  "do",
  "compact",
  "permission",
  "session",
  "memory",
  "status",
] as const;

const RESERVED = new Set<string>(RESERVED_SKILL_COMMANDS);

export interface SkillCommandBridge {
  runSkill: (run: SkillRun) => Promise<string>;
}

/** 按当前目录增删 Skill 短命令 */
export class SkillCommandSync {
  private registered: string[] = [];

  constructor(
    private readonly catalog: SkillCatalog,
    private readonly bridge: SkillCommandBridge,
  ) {}

  sync(registry: CommandRegistry): void {
    for (const name of this.registered) {
      registry.unregister(name);
    }
    this.registered = [];

    const catalog = this.catalog;
    const bridge = this.bridge;
    for (const skill of catalog.list()) {
      const name = skill.name;
      const existing = registry.get(name);
      if (RESERVED.has(name) || (existing && RESERVED.has(existing.name))) {
        continue;
      }
      if (existing) registry.unregister(existing.name);
      registry.register({
        name,
        description: skill.description,
        usage: `/${name} [参数]`,
        type: "prompt",
        handler: async (ctx, args) => {
          const current = catalog.get(name);
          if (!current) return;
          await bridge.runSkill({
            sessionId: ctx.sessionId,
            skill: current,
            args,
          });
        },
      });
      this.registered.push(name);
    }
  }
}
