/** 一次创建或快速恢复后的工作目录描述。 */
export interface WorktreeInfo {
  name: string;
  /** 隔离目录绝对路径 */
  path: string;
  /** 检出分支，如 mew/agents__foo-deadbeef */
  branch: string;
  /** 本次是否新建；false 表示快速恢复 */
  created: boolean;
}

/** 删除保护用的脏状态。 */
export interface DirtyState {
  uncommitted: boolean;
  unpushed: boolean;
  blocked: boolean;
}

export type NameValidation =
  | { ok: true; name: string }
  | { ok: false; reason: string };
