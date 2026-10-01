import { readFileSync } from "node:fs";

export function loadText(path: string): string {
  return readFileSync(path, "utf8");
}
