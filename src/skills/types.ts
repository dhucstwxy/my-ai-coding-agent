export type SkillScope = "project" | "user" | "builtin";

export type SkillMode = "shared" | "isolated";

export interface SkillRecord {
  name: string;
  description: string;
  /** 省略表示不收窄；空数组表示写了白名单但没有工具 */
  tools?: string[];
  mode: SkillMode;
  history: number;
  model?: string;
  body: string;
  scope: SkillScope;
  entryPath: string;
  /** 目录型 Skill 的包目录；单文件为空 */
  packageDir?: string;
  companions: string[];
}

export interface SkillWarning {
  path: string;
  reason: string;
}

export interface SkillRun {
  sessionId: string;
  skill: SkillRecord;
  args: string;
}

export type SkillFatalKind = "duplicate_name" | "unknown_tool";

/** 同层重名或白名单指向不存在的工具 */
export class SkillFatalError extends Error {
  readonly kind: SkillFatalKind;
  readonly skillName: string;
  readonly scope: SkillScope;
  readonly toolName?: string;

  constructor(
    kind: SkillFatalKind,
    skillName: string,
    scope: SkillScope,
    toolName?: string,
  ) {
    const scopeLabel =
      scope === "project" ? "项目级" : scope === "user" ? "用户级" : "内置";
    const message =
      kind === "duplicate_name"
        ? `Skill 名称在${scopeLabel}重复：${skillName}`
        : `Skill「${skillName}」的白名单包含不存在的工具：${toolName ?? ""}`;
    super(message);
    this.name = "SkillFatalError";
    this.kind = kind;
    this.skillName = skillName;
    this.scope = scope;
    this.toolName = toolName;
  }
}
