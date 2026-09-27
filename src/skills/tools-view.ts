import type { SkillRecord } from "./types.js";

const PLAN_READONLY = new Set(["read_file", "glob_files", "grep_search"]);

const LOAD_SKILL = "load_skill";

/**
 * 先按计划/执行模式过滤，再对写了白名单的已激活 Skill 取交集。
 * 结果始终包含 load_skill。
 */
export function visibleToolNames(input: {
  allNames: string[];
  planMode: "plan" | "execute";
  active: SkillRecord[];
}): string[] {
  let names =
    input.planMode === "plan"
      ? input.allNames.filter((name) => PLAN_READONLY.has(name))
      : [...input.allNames];

  const narrowing = input.active.filter((skill) => skill.tools !== undefined);
  for (const skill of narrowing) {
    const allow = new Set(skill.tools);
    names = names.filter((name) => allow.has(name));
  }

  if (!names.includes(LOAD_SKILL)) {
    names.push(LOAD_SKILL);
  }
  return names;
}
