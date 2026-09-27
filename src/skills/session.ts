import type { SkillCatalog } from "./catalog.js";
import type { SkillRecord } from "./types.js";

interface ActiveEntry {
  name: string;
  args: string;
}

/** 进程内、按会话保存已激活 Skill，不写 JSONL */
export class SkillSession {
  private readonly bySession = new Map<string, ActiveEntry[]>();

  activate(sessionId: string, name: string, args: string): void {
    const key = name.toLowerCase();
    const list = this.bySession.get(sessionId) ?? [];
    const next = list.filter((item) => item.name !== key);
    next.push({ name: key, args });
    this.bySession.set(sessionId, next);
  }

  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  active(sessionId: string): ActiveEntry[] {
    return [...(this.bySession.get(sessionId) ?? [])];
  }

  /** 从后往前，最后一个写了模型的已激活 Skill */
  modelFor(sessionId: string, catalog: SkillCatalog): string | undefined {
    const list = this.bySession.get(sessionId) ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      const rec = catalog.get(list[i]!.name);
      if (rec?.model) return rec.model;
    }
    return undefined;
  }

  recordsFor(sessionId: string, catalog: SkillCatalog): SkillRecord[] {
    const list = this.bySession.get(sessionId) ?? [];
    const kept: ActiveEntry[] = [];
    const records: SkillRecord[] = [];
    for (const item of list) {
      const rec = catalog.get(item.name);
      if (!rec) continue;
      kept.push(item);
      records.push(rec);
    }
    this.bySession.set(sessionId, kept);
    return records;
  }

  /** 用目录里的当前正文替换全部 $ARGUMENTS */
  pinnedText(sessionId: string, catalog: SkillCatalog): string {
    const list = this.bySession.get(sessionId) ?? [];
    const kept: ActiveEntry[] = [];
    const blocks: string[] = [];
    for (const item of list) {
      const rec = catalog.get(item.name);
      if (!rec) continue;
      kept.push(item);
      const body = rec.body.split("$ARGUMENTS").join(item.args);
      blocks.push(`## 已激活 Skill：${rec.name}\n\n${body.trim()}`);
    }
    this.bySession.set(sessionId, kept);
    return blocks.join("\n\n");
  }
}
