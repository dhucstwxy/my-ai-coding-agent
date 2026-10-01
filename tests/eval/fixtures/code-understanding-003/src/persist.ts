import { writeFileSync } from "node:fs";

export function saveToDisk(path: string, content: string): void {
  writeFileSync(path, content, "utf8");
}
