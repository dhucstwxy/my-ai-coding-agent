import { editFileTool } from "./edit-file.js";
import { globFilesTool } from "./glob-files.js";
import { grepSearchTool } from "./grep-search.js";
import { readFileTool } from "./read-file.js";
import { ToolRegistry } from "./registry.js";
import { runCommandTool } from "./run-command.js";
import { writeFileTool } from "./write-file.js";

/** 创建并登记六个核心工具 */
export function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(editFileTool);
  registry.register(runCommandTool);
  registry.register(globFilesTool);
  registry.register(grepSearchTool);
  return registry;
}
