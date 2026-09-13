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

/** 会话目录：~/.mewcode/sessions */
export function sessionsDir(home = os.homedir()): string {
  return path.join(home, ".mewcode", "sessions");
}
