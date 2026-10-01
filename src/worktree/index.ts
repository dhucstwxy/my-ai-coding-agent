export type { DirtyState, NameValidation, WorktreeInfo } from "./types.js";
export {
  generateAgentWorktreeName,
  normalizeName,
  toBranchName,
  validateName,
} from "./name.js";
export { WorktreeService } from "./service.js";
export { startWorktreeJanitor, type JanitorOptions } from "./janitor.js";
export { initializeWorktree } from "./init.js";
