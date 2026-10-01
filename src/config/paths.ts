import os from "node:os";
import path from "node:path";

/** 项目内配置：./.mewcode/config.yaml */
export function projectConfigPath(cwd = process.cwd()): string {
  return path.join(cwd, ".mewcode", "config.yaml");
}

/** 用户配置：~/.mewcode/config.yaml */
export function userConfigPath(home = os.homedir()): string {
  return path.join(home, ".mewcode", "config.yaml");
}

/** 用户 .mewcode 根目录 */
export function userMewcodeDir(home = os.homedir()): string {
  return path.join(home, ".mewcode");
}

/** 项目会话目录：<cwd>/.mewcode/sessions */
export function projectSessionsDir(cwd = process.cwd()): string {
  return path.join(cwd, ".mewcode", "sessions");
}

/** 项目记忆目录：<cwd>/.mewcode/memory */
export function projectMemoryDir(cwd = process.cwd()): string {
  return path.join(cwd, ".mewcode", "memory");
}

/** 用户记忆目录：~/.mewcode/memory */
export function userMemoryDir(home = os.homedir()): string {
  return path.join(home, ".mewcode", "memory");
}

/** 项目 Skill 目录：<cwd>/.mewcode/skills */
export function projectSkillsDir(cwd = process.cwd()): string {
  return path.join(cwd, ".mewcode", "skills");
}

/** 用户 Skill 目录：~/.mewcode/skills */
export function userSkillsDir(home = os.homedir()): string {
  return path.join(home, ".mewcode", "skills");
}

/** 用户 Hook：~/.mewcode/hooks.yaml */
export function userHooksPath(home = os.homedir()): string {
  return path.join(home, ".mewcode", "hooks.yaml");
}

/** 项目 Hook：<cwd>/.mewcode/hooks.yaml */
export function projectHooksPath(cwd = process.cwd()): string {
  return path.join(cwd, ".mewcode", "hooks.yaml");
}

/** 本地 Hook：<cwd>/.mewcode/hooks.local.yaml */
export function localHooksPath(cwd = process.cwd()): string {
  return path.join(cwd, ".mewcode", "hooks.local.yaml");
}

/** 用户角色目录：~/.mewcode/agents */
export function userAgentsDir(home = os.homedir()): string {
  return path.join(home, ".mewcode", "agents");
}

/** 项目角色目录：<cwd>/.mewcode/agents */
export function projectAgentsDir(cwd = process.cwd()): string {
  return path.join(cwd, ".mewcode", "agents");
}

/** 项目 Worktree 目录：<cwd>/.mewcode/worktrees */
export function projectWorktreesDir(cwd = process.cwd()): string {
  return path.join(cwd, ".mewcode", "worktrees");
}

/** @deprecated 旧全局会话目录，本章起不再作为主存储 */
export function sessionsDir(home = os.homedir()): string {
  return path.join(home, ".mewcode", "sessions");
}
