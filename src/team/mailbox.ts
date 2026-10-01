import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  mailboxLockPath,
  mailboxPath,
  mailDir,
  registryJsonPath,
} from "./paths.js";
import type { MailDraft, MailMessage, NameEntry } from "./types.js";

const LOCK_TTL_MS = 10_000;
const LOCK_RETRIES = 20;
const LOCK_WAIT_MS = 50;

export class TeamRegistry {
  constructor(private readonly rootPath: string) {
    fs.mkdirSync(mailDir(rootPath), { recursive: true });
    if (!fs.existsSync(registryJsonPath(rootPath))) {
      this.write([]);
    }
  }

  list(): NameEntry[] {
    return this.read();
  }

  get(name: string): NameEntry | undefined {
    return this.read().find((e) => e.name === name);
  }

  upsert(entry: NameEntry): void {
    const all = this.read();
    const idx = all.findIndex((e) => e.name === entry.name);
    if (idx >= 0) all[idx] = entry;
    else all.push(entry);
    this.write(all);
  }

  remove(name: string): void {
    this.write(this.read().filter((e) => e.name !== name));
  }

  private read(): NameEntry[] {
    const file = registryJsonPath(this.rootPath);
    if (!fs.existsSync(file)) return [];
    return JSON.parse(fs.readFileSync(file, "utf8")) as NameEntry[];
  }

  private write(entries: NameEntry[]): void {
    fs.writeFileSync(
      registryJsonPath(this.rootPath),
      JSON.stringify(entries, null, 2) + "\n",
      "utf8",
    );
  }
}

export class Mailbox {
  constructor(
    private readonly rootPath: string,
    private readonly registry: TeamRegistry,
  ) {}

  async send(to: string, draft: MailDraft): Promise<MailMessage> {
    const entry = this.registry.get(to);
    if (!entry) throw new Error(`注册表中找不到：${to}`);
    const msg: MailMessage = {
      id: randomUUID(),
      from: draft.from,
      body: draft.body,
      timestamp: new Date().toISOString(),
      read: false,
      summary: draft.summary?.trim() || summarize(draft.body),
      ...(draft.type ? { type: draft.type } : {}),
    };
    await withLock(mailboxLockPath(this.rootPath, to), async () => {
      const list = readMail(mailboxPath(this.rootPath, to));
      list.push(msg);
      writeMail(mailboxPath(this.rootPath, to), list);
    });
    return msg;
  }

  async broadcast(from: string, draft: Omit<MailDraft, "from">): Promise<number> {
    const names = this.registry
      .list()
      .map((e) => e.name)
      .filter((n) => n !== from);
    for (const to of names) {
      await this.send(to, { ...draft, from });
    }
    return names.length;
  }

  list(member: string): MailMessage[] {
    return readMail(mailboxPath(this.rootPath, member));
  }

  async markRead(member: string, id: string): Promise<boolean> {
    let found = false;
    await withLock(mailboxLockPath(this.rootPath, member), async () => {
      const list = readMail(mailboxPath(this.rootPath, member));
      for (const m of list) {
        if (m.id === id) {
          m.read = true;
          found = true;
        }
      }
      writeMail(mailboxPath(this.rootPath, member), list);
    });
    return found;
  }

  ensureMailbox(member: string): void {
    const p = mailboxPath(this.rootPath, member);
    if (!fs.existsSync(p)) {
      fs.mkdirSync(mailDir(this.rootPath), { recursive: true });
      writeMail(p, []);
    }
    if (!this.registry.get(member)) {
      this.registry.upsert({
        name: member,
        mailboxRel: `mail/${member}.json`,
      });
    }
  }
}

function summarize(body: string): string {
  const t = body.trim().replace(/\s+/g, " ");
  return t.length <= 80 ? t : `${t.slice(0, 77)}...`;
}

function readMail(file: string): MailMessage[] {
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf8")) as MailMessage[];
}

function writeMail(file: string, list: MailMessage[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(list, null, 2) + "\n", "utf8");
}

export async function withLock(
  lockPath: string,
  fn: () => void | Promise<void>,
): Promise<void> {
  for (let i = 0; i < LOCK_RETRIES; i++) {
    try {
      if (fs.existsSync(lockPath)) {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_TTL_MS) {
          try {
            fs.unlinkSync(lockPath);
          } catch {
            // ignore
          }
        }
      }
      const fd = fs.openSync(lockPath, "wx");
      try {
        await fn();
      } finally {
        fs.closeSync(fd);
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // ignore
        }
      }
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      await sleep(LOCK_WAIT_MS);
    }
  }
  throw new Error(`无法获取邮箱锁：${lockPath}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export { LOCK_TTL_MS };
