import { loadConfig } from "./config/load.js";
import { ConfigError } from "./config/validate.js";
import { projectSessionsDir } from "./config/paths.js";
import { createProvider } from "./provider/factory.js";
import { SessionStore } from "./session/store.js";
import { cleanupExpiredSessions } from "./session/cleanup.js";
import { ChatService } from "./chat/service.js";
import { createDefaultRegistry } from "./tools/create-registry.js";
import { startApp } from "./tui/index.js";
import { PermissionGate } from "./permission/gate.js";
import { loadPermissionRules } from "./permission/load.js";
import { PermissionModeStore } from "./permission/mode-store.js";
import { SessionGrantStore } from "./permission/session-grants.js";
import { connectMcpServers } from "./mcp/register.js";
import { loadInstructions } from "./instructions/index.js";
import { loadMemoryText } from "./memory/index.js";
import {
  buildDefaultRegistry,
  CommandConflictError,
} from "./commands/index.js";

/** 组装依赖并启动 TUI */
export async function runCli(): Promise<void> {
  let loaded;
  try {
    loaded = loadConfig();
  } catch (err) {
    const msg =
      err instanceof ConfigError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    console.error(`配置错误：${msg}`);
    process.exitCode = 1;
    return;
  }

  const active = loaded.config.providers.find(
    (p) => p.name === loaded.config.activeProvider,
  );
  if (!active) {
    console.error("配置错误：找不到当前供应商");
    process.exitCode = 1;
    return;
  }

  let commandRegistry;
  try {
    commandRegistry = buildDefaultRegistry();
  } catch (err) {
    if (err instanceof CommandConflictError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const workspaceRoot = process.cwd();
  const sessionsPath = projectSessionsDir(workspaceRoot);
  const cleaned = cleanupExpiredSessions(sessionsPath);
  if (cleaned.removed.length > 0) {
    console.log(
      `已清理 ${cleaned.removed.length} 个过期会话（超过 30 天）`,
    );
  }

  const instructions = loadInstructions(workspaceRoot);
  const memory = loadMemoryText(workspaceRoot);

  const provider = createProvider(active);
  const store = new SessionStore(sessionsPath);
  const registry = createDefaultRegistry();
  const mcp = await connectMcpServers(workspaceRoot, registry);
  const ruleSet = loadPermissionRules(workspaceRoot);
  const permissionModes = new PermissionModeStore();
  const grants = new SessionGrantStore();
  const gate = new PermissionGate({
    rules: ruleSet.rules,
    modeStore: permissionModes,
    grants,
    workspaceRoot,
  });
  const chat = new ChatService(
    store,
    provider,
    active,
    registry,
    workspaceRoot,
    gate,
    permissionModes,
    commandRegistry,
    undefined,
    {
      customInstructions: instructions.text || undefined,
      memoryText: memory.text || undefined,
    },
  );

  console.log(
    `已加载配置（${loaded.source}），供应商：${active.name} / ${active.protocol} / ${active.model}`,
  );
  console.log(`工作区：${workspaceRoot}`);
  console.log(`会话目录：${sessionsPath}`);

  let closing: Promise<void> | null = null;
  const shutdown = () => {
    if (!closing) closing = mcp.close();
    return closing;
  };
  process.once("beforeExit", () => {
    void shutdown();
  });
  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });

  startApp({
    store,
    chat,
    warnings: [
      ...loaded.warnings,
      ...ruleSet.warnings,
      ...mcp.warnings,
      ...instructions.warnings,
      ...memory.warnings,
    ],
  });
}
