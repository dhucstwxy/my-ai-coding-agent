import fs from "node:fs";
import path from "node:path";
import { projectWorktreesDir } from "../config/paths.js";
import {
  hasUnpushed,
  revParseHead,
  statusPorcelain,
  worktreeAdd,
  worktreeList,
  worktreeRemove,
} from "./git.js";
import { initializeWorktree } from "./init.js";
import { toBranchName, validateName } from "./name.js";
import type { DirtyState, WorktreeInfo } from "./types.js";

interface Meta {
  baselineSha: string;
  lastUsedAt: number;
  active: boolean;
  branch: string;
}

export class WorktreeService {
  private readonly meta = new Map<string, Meta>();

  constructor(private readonly repoRoot: string) {}

  validateName(name: string) {
    return validateName(name);
  }

  absolutePath(name: string): string {
    const v = validateName(name);
    if (!v.ok) throw new Error(v.reason);
    return path.join(projectWorktreesDir(this.repoRoot), ...v.name.split("/"));
  }

  async create(name: string): Promise<WorktreeInfo> {
    const v = validateName(name);
    if (!v.ok) throw new Error(v.reason);

    const abs = this.absolutePath(v.name);
    const branch = toBranchName(v.name);

    if (fs.existsSync(abs)) {
      await initializeWorktree(this.repoRoot, abs);
      const baseline =
        this.meta.get(v.name)?.baselineSha ?? (await revParseHead(abs));
      this.ensureMeta(v.name, {
        baselineSha: baseline,
        branch,
        lastUsedAt: Date.now(),
        active: false,
      });
      this.markUsed(v.name);
      return {
        name: v.name,
        path: abs,
        branch: this.meta.get(v.name)!.branch,
        created: false,
      };
    }

    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const baselineSha = await revParseHead(this.repoRoot);
    try {
      await worktreeAdd(this.repoRoot, abs, branch);
      await initializeWorktree(this.repoRoot, abs);
    } catch (err) {
      await this.rollbackCreate(abs);
      throw err;
    }

    this.ensureMeta(v.name, {
      baselineSha,
      branch,
      lastUsedAt: Date.now(),
      active: false,
    });
    this.markUsed(v.name);
    return { name: v.name, path: abs, branch, created: true };
  }

  enter(name: string): WorktreeInfo {
    const v = validateName(name);
    if (!v.ok) throw new Error(v.reason);
    const abs = this.absolutePath(v.name);
    if (!fs.existsSync(abs)) {
      throw new Error(`工作目录不存在：${v.name}`);
    }
    const existing = this.meta.get(v.name);
    const branch = existing?.branch ?? toBranchName(v.name);
    if (!existing) {
      this.ensureMeta(v.name, {
        baselineSha: "",
        branch,
        lastUsedAt: Date.now(),
        active: true,
      });
      void revParseHead(abs).then((sha) => {
        const m = this.meta.get(v.name);
        if (m && !m.baselineSha) m.baselineSha = sha;
      });
    }
    this.meta.get(v.name)!.active = true;
    this.markUsed(v.name);
    return {
      name: v.name,
      path: abs,
      branch,
      created: false,
    };
  }

  exit(name: string): void {
    const v = validateName(name);
    if (!v.ok) return;
    const m = this.meta.get(v.name);
    if (m) m.active = false;
  }

  markUsed(name: string): void {
    const v = validateName(name);
    if (!v.ok) return;
    const m = this.meta.get(v.name);
    if (m) m.lastUsedAt = Date.now();
  }

  isActive(name: string): boolean {
    const v = validateName(name);
    if (!v.ok) return false;
    return this.meta.get(v.name)?.active === true;
  }

  lastUsedAt(name: string): number | undefined {
    const v = validateName(name);
    if (!v.ok) return undefined;
    return this.meta.get(v.name)?.lastUsedAt;
  }

  /** 测试/janitor：覆盖最近使用时间。 */
  setLastUsedAt(name: string, at: number): void {
    const v = validateName(name);
    if (!v.ok) return;
    const m = this.meta.get(v.name);
    if (m) m.lastUsedAt = at;
  }

  async isDirty(name: string): Promise<DirtyState> {
    const v = validateName(name);
    if (!v.ok) {
      return { uncommitted: false, unpushed: false, blocked: false };
    }
    const abs = this.absolutePath(v.name);
    if (!fs.existsSync(abs)) {
      return { uncommitted: false, unpushed: false, blocked: false };
    }
    const porcelain = await statusPorcelain(abs);
    const uncommitted = porcelain.length > 0;
    const baseline = this.meta.get(v.name)?.baselineSha;
    const unpushed = await hasUnpushed(abs, baseline || undefined);
    return {
      uncommitted,
      unpushed,
      blocked: uncommitted || unpushed,
    };
  }

  async remove(name: string): Promise<void> {
    const v = validateName(name);
    if (!v.ok) throw new Error(v.reason);
    const abs = this.absolutePath(v.name);
    if (!fs.existsSync(abs)) {
      this.meta.delete(v.name);
      return;
    }
    const dirty = await this.isDirty(v.name);
    if (dirty.blocked) {
      const parts: string[] = [];
      if (dirty.uncommitted) parts.push("未提交修改");
      if (dirty.unpushed) parts.push("未推送的本地 commit");
      throw new Error(`拒绝删除工作目录（${parts.join("、")}）：${v.name}`);
    }
    try {
      await worktreeRemove(this.repoRoot, abs);
    } catch {
      if (fs.existsSync(abs)) {
        fs.rmSync(abs, { recursive: true, force: true });
      }
    }
    this.meta.delete(v.name);
  }

  async list(): Promise<WorktreeInfo[]> {
    const root = projectWorktreesDir(this.repoRoot);
    if (!fs.existsSync(root)) return [];
    const listed = await worktreeList(this.repoRoot);
    const result: WorktreeInfo[] = [];
    const walk = (dir: string, prefix: string) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
        const abs = path.join(dir, ent.name);
        const v = validateName(rel);
        if (!v.ok) continue;
        const isLeaf =
          fs.existsSync(path.join(abs, ".git")) ||
          listed.some(
            (w) => path.resolve(w.path) === path.resolve(abs),
          );
        if (isLeaf) {
          result.push({
            name: v.name,
            path: abs,
            branch: this.meta.get(v.name)?.branch ?? toBranchName(v.name),
            created: false,
          });
        } else {
          walk(abs, rel);
        }
      }
    };
    walk(root, "");
    return result;
  }

  private ensureMeta(name: string, meta: Meta): void {
    const prev = this.meta.get(name);
    if (prev) {
      prev.baselineSha = prev.baselineSha || meta.baselineSha;
      prev.branch = meta.branch;
      prev.lastUsedAt = meta.lastUsedAt;
      return;
    }
    this.meta.set(name, meta);
  }

  private async rollbackCreate(absPath: string): Promise<void> {
    try {
      await worktreeRemove(this.repoRoot, absPath);
    } catch {
      if (fs.existsSync(absPath)) {
        fs.rmSync(absPath, { recursive: true, force: true });
      }
    }
  }
}
