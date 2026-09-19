export interface BlacklistMatch {
  matched: boolean;
  message: string;
}

/**
 * 内置高危命令检查。不读配置，档位和规则都不能放开。
 * 比较前会压缩空白并忽略大小写。
 */
export function matchBlacklist(command: string): BlacklistMatch {
  const normalized = command.replace(/\s+/g, " ").trim().toLowerCase();
  for (const rule of RULES) {
    if (rule.test(normalized)) {
      return { matched: true, message: rule.message };
    }
  }
  return { matched: false, message: "" };
}

const RULES: Array<{ test: (command: string) => boolean; message: string }> = [
  { test: isDangerousRm, message: "删除根目录或用户主目录" },
  { test: isFormatDisk, message: "格式化磁盘" },
  { test: isPowerOff, message: "关机或重启" },
  { test: isDownloadToShell, message: "下载内容送进 shell" },
];

/** rm 带递归且强制，目标是根目录、家目录或对应环境变量。 */
function isDangerousRm(command: string): boolean {
  const matched = command.match(
    /\brm\s+((?:-{1,2}[a-z0-9-]+\s+)+)(?:\/(?:\*|(?=\s|$))|~(?:\/\S*)?|\$home(?:\/\S*)?|\$\{home\}(?:\/\S*)?|%userprofile%(?:\\\S*)?)/,
  );
  if (!matched) return false;
  let recursive = false;
  let force = false;
  for (const flag of (matched[1] ?? "").trim().split(/\s+/)) {
    if (flag === "--recursive") recursive = true;
    else if (flag === "--force") force = true;
    else if (flag.startsWith("-") && !flag.startsWith("--")) {
      if (flag.includes("r")) recursive = true;
      if (flag.includes("f")) force = true;
    }
  }
  return recursive && force;
}

function isFormatDisk(command: string): boolean {
  return (
    /\bmkfs(?:\.[a-z0-9]+)?\b/.test(command) ||
    /\bformat\s+[a-z]:/.test(command) ||
    /\bdiskpart\b/.test(command)
  );
}

function isPowerOff(command: string): boolean {
  return /\b(?:shutdown|reboot|halt|poweroff)\b/.test(command);
}

function isDownloadToShell(command: string): boolean {
  if (/\b(?:curl|wget)\b[\s\S]*\|\s*(?:sudo\s+)?(?:sh|bash)\b/.test(command)) {
    return true;
  }
  return /\b(?:iwr|irm|invoke-webrequest|invoke-restmethod)\b[\s\S]*\|\s*(?:iex|invoke-expression)\b/.test(
    command,
  );
}
