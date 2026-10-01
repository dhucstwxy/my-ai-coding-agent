export function isValidUsername(input: string): boolean {
  if (!input || /\s/.test(input)) return false;
  // 错误：要求必须是纯字母数字，导致邮箱失败
  return /^[a-zA-Z0-9]+$/.test(input);
}
