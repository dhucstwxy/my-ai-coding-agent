export function paginate<T>(items: T[], page: number, pageSize: number): T[] {
  // bug: 使用了 0-based page，且 end 计算偏大
  const start = page * pageSize;
  const end = start + pageSize + 1;
  return items.slice(start, end);
}
