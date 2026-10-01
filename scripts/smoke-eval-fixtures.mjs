import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = join(root, "tests", "eval", "fixtures");

function npmTest(id) {
  const cwd = join(fixtures, id);
  const r = spawnSync("npm", ["test"], { cwd, encoding: "utf8", shell: true });
  return r.status ?? 1;
}

function write(id, rel, content) {
  const p = join(fixtures, id, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

const expectFail = [
  "code-understanding-001",
  "code-understanding-002",
  "code-understanding-003",
  "code-understanding-004",
  "code-edit-001",
  "code-edit-002",
  "code-edit-003",
  "code-edit-004",
  "bugfix-001",
  "bugfix-002",
  "bugfix-003",
  "bugfix-004",
  "multi-step-001",
  "multi-step-002",
  "multi-step-003",
  "multi-step-004",
  "error-handling-001",
  "error-handling-004",
];
const expectPass = ["error-handling-002", "error-handling-003"];

let failed = 0;
console.log("=== BASELINE ===");
for (const id of expectFail) {
  const code = npmTest(id);
  const ok = code !== 0;
  console.log(`${ok ? "OK" : "BAD"} fail-expected ${id} exit=${code}`);
  if (!ok) failed++;
}
for (const id of expectPass) {
  const code = npmTest(id);
  const ok = code === 0;
  console.log(`${ok ? "OK" : "BAD"} pass-expected ${id} exit=${code}`);
  if (!ok) failed++;
}

console.log("=== GOLDEN PATH SPOT CHECKS ===");

write(
  "code-understanding-001",
  "answer.json",
  JSON.stringify({ exportName: "applyDiscount", defaultRate: 0.15 })
);
{
  const code = npmTest("code-understanding-001");
  console.log(`${code === 0 ? "OK" : "BAD"} understanding-001 correct answer exit=${code}`);
  if (code !== 0) failed++;
  rmSync(join(fixtures, "code-understanding-001", "answer.json"));
}

write(
  "error-handling-001",
  "result.json",
  JSON.stringify({ rejected: true })
);
{
  const code = npmTest("error-handling-001");
  console.log(`${code === 0 ? "OK" : "BAD"} error-handling-001 reject exit=${code}`);
  if (code !== 0) failed++;
  rmSync(join(fixtures, "error-handling-001", "result.json"));
}

write(
  "code-edit-001",
  "src/math.ts",
  `export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
`
);
{
  const code = npmTest("code-edit-001");
  console.log(`${code === 0 ? "OK" : "BAD"} code-edit-001 fixed exit=${code}`);
  if (code !== 0) failed++;
  // restore stub
  write(
    "code-edit-001",
    "src/math.ts",
    `export function clamp(n: number, min: number, max: number): number {
  // TODO: 实现夹逼
  return n;
}
`
  );
}

write(
  "bugfix-001",
  "src/sum-range.ts",
  `export function sumRange(start: number, end: number): number {
  let sum = 0;
  for (let i = start; i <= end; i++) sum += i;
  return sum;
}
`
);
{
  const code = npmTest("bugfix-001");
  console.log(`${code === 0 ? "OK" : "BAD"} bugfix-001 fixed exit=${code}`);
  if (code !== 0) failed++;
  write(
    "bugfix-001",
    "src/sum-range.ts",
    `/** 计算闭区间 [start, end] 的整数和 */
export function sumRange(start: number, end: number): number {
  let sum = 0;
  for (let i = start; i < end; i++) {
    sum += i;
  }
  return sum;
}
`
  );
}

write(
  "error-handling-004",
  "src/buggy.ts",
  `export function double(n: number): number {
  return n * 2;
}
`
);
{
  const code = npmTest("error-handling-004");
  console.log(`${code === 0 ? "OK" : "BAD"} error-handling-004 fixed exit=${code}`);
  if (code !== 0) failed++;
  write(
    "error-handling-004",
    "src/buggy.ts",
    `export function double(n: number): number {
  return n + 2; // bug: 应该是 * 2
}
`
  );
}

// tamper test protection
{
  const testFile = join(fixtures, "code-edit-001", "tests", "math.test.ts");
  const original = readFileSync(testFile, "utf8");
  writeFileSync(testFile, original + "\n// tamper\n");
  const code = npmTest("code-edit-001");
  console.log(`${code !== 0 ? "OK" : "BAD"} integrity catches tamper exit=${code}`);
  if (code === 0) failed++;
  writeFileSync(testFile, original);
}

console.log(failed === 0 ? "ALL SMOKE CHECKS PASSED" : `SMOKE FAILURES: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
