import fs from "node:fs";
import os from "node:os";
import {
  mailDir,
  mailboxPath,
  teamJsonPath,
  teamRoot,
  userTeamsDir,
  validateMemberName,
  validateTeamName,
} from "./paths.js";
import type { MemberRecord, TeamRecord } from "./types.js";

const LEAD_NAME = "lead";

export class TeamStore {
  private current: TeamRecord | null = null;

  constructor(private readonly homeDir: string = os.homedir()) {}

  active(): TeamRecord | null {
    return this.current;
  }

  create(name: string): TeamRecord {
    const v = validateTeamName(name);
    if (!v.ok) throw new Error(v.reason);
    const root = teamRoot(v.name, this.homeDir);
    if (fs.existsSync(teamJsonPath(root))) {
      return this.resume(v.name);
    }
    if (this.current) {
      throw new Error(
        `已有活跃小组「${this.current.name}」，请先停用再创建「${v.name}」`,
      );
    }
    fs.mkdirSync(mailDir(root), { recursive: true });
    const now = new Date().toISOString();
    const record: TeamRecord = {
      name: v.name,
      leadName: LEAD_NAME,
      rootPath: root,
      members: [
        {
          name: LEAD_NAME,
          role: "lead",
          workdir: "main",
          backend: "inprocess",
          requiresApproval: false,
          status: "idle",
          approved: true,
        },
      ],
      createdAt: now,
      updatedAt: now,
    };
    this.writeTeam(record);
    fs.writeFileSync(mailboxPath(root, LEAD_NAME), "[]\n", "utf8");
    this.current = record;
    return record;
  }

  resume(name: string): TeamRecord {
    const v = validateTeamName(name);
    if (!v.ok) throw new Error(v.reason);
    if (this.current && this.current.name !== v.name) {
      throw new Error(
        `已有活跃小组「${this.current.name}」，请先停用再恢复「${v.name}」`,
      );
    }
    const root = teamRoot(v.name, this.homeDir);
    const file = teamJsonPath(root);
    if (!fs.existsSync(file)) {
      throw new Error(`小组不存在：${v.name}`);
    }
    const record = JSON.parse(fs.readFileSync(file, "utf8")) as TeamRecord;
    record.rootPath = root;
    this.current = record;
    return record;
  }

  deactivate(): void {
    if (!this.current) return;
    for (const m of this.current.members) {
      if (m.status === "running") m.status = "idle";
    }
    this.current.updatedAt = new Date().toISOString();
    this.writeTeam(this.current);
    this.current = null;
  }

  disband(): void {
    if (!this.current) throw new Error("没有活跃小组");
    const root = this.current.rootPath;
    this.current = null;
    fs.rmSync(root, { recursive: true, force: true });
  }

  upsertMember(member: MemberRecord): void {
    const team = this.requireActive();
    const v = validateMemberName(member.name);
    if (!v.ok) throw new Error(v.reason);
    const idx = team.members.findIndex((m) => m.name === v.name);
    const next = { ...member, name: v.name };
    if (idx >= 0) team.members[idx] = next;
    else team.members.push(next);
    team.updatedAt = new Date().toISOString();
    this.writeTeam(team);
  }

  getMember(name: string): MemberRecord | undefined {
    const team = this.current;
    if (!team) return undefined;
    return team.members.find((m) => m.name === name);
  }

  listMembers(): MemberRecord[] {
    return this.current ? [...this.current.members] : [];
  }

  requireActive(): TeamRecord {
    if (!this.current) throw new Error("没有活跃小组");
    return this.current;
  }

  save(): void {
    if (!this.current) return;
    this.current.updatedAt = new Date().toISOString();
    this.writeTeam(this.current);
  }

  listTeamNames(): string[] {
    const root = userTeamsDir(this.homeDir);
    if (!fs.existsSync(root)) return [];
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  }

  private writeTeam(record: TeamRecord): void {
    fs.mkdirSync(record.rootPath, { recursive: true });
    fs.writeFileSync(
      teamJsonPath(record.rootPath),
      JSON.stringify(record, null, 2) + "\n",
      "utf8",
    );
  }
}

export { LEAD_NAME };
