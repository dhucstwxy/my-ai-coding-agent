const mem = new Map<string, string>();

export function putCache(key: string, value: string): void {
  mem.set(key, value);
}
