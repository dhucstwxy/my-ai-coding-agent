/**
 * 精确规则要求全等。含 * 时每个 * 匹配任意长度（含空、含路径分隔符）。
 * 其余字符按字面量对待，不把用户模式当成正则。
 */
export function ruleMatches(pattern: string, subject: string): boolean {
  if (!pattern.includes("*")) return pattern === subject;
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\s\\S]*");
  return new RegExp(`^${source}$`).test(subject);
}
