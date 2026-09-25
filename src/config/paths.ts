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

/** @deprecated 旧全局会话目录，本章起不再作为主存储 */
export function sessionsDir(home = os.homedir()): string {
  return path.join(home, ".mewcode", "sessions");
}
