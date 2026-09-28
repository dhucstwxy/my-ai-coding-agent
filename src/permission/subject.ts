export type SubjectResult =
  | { ok: true; subject: string }
  | { ok: false; message: string };

const PATH_TOOLS = new Set(["read_file", "write_file", "edit_file"]);

/**
 * 取出本轮要匹配的字符串。参数缺失时失败，由闸门拒绝。
 */
export function permissionSubject(tool: string, args: unknown): SubjectResult {
  if (tool.includes("__")) {
    const [server, remote] = tool.split("__");
    if (server && remote) {
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        return { ok: true, subject: "{}" };
      }
      return { ok: true, subject: stableJson(args) };
    }
  }

  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return { ok: false, message: "参数无法解析" };
  }
  const record = args as Record<string, unknown>;

  if (tool === "run_command") {
    if (typeof record.command !== "string" || record.command.trim() === "") {
      return { ok: false, message: "缺少命令参数" };
    }
    return { ok: true, subject: record.command };
  }

  if (PATH_TOOLS.has(tool)) {
    if (typeof record.path !== "string" || record.path.trim() === "") {
      return { ok: false, message: "缺少路径参数" };
    }
    return { ok: true, subject: record.path };
  }

  if (tool === "grep_search") {
    if (record.path === undefined) return { ok: true, subject: "." };
    if (typeof record.path !== "string" || record.path.trim() === "") {
      return { ok: false, message: "搜索路径不合法" };
    }
    return { ok: true, subject: record.path };
  }

  if (tool === "agent") {
    if (typeof record.task !== "string" || record.task.trim() === "") {
      return { ok: false, message: "缺少任务说明" };
    }
    return { ok: true, subject: record.task.trim() };
  }

  if (tool === "glob_files") {
    if (typeof record.pattern !== "string" || record.pattern.trim() === "") {
      return { ok: false, message: "缺少查找模式" };
    }
    return { ok: true, subject: record.pattern };
  }

  return { ok: false, message: `不支持的工具：${tool}` };
}

/** 对象键递归按字典序排序，数组顺序不变。 */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value ?? {}));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortKeys(record[key]);
    }
    return sorted;
  }
  return value;
}
