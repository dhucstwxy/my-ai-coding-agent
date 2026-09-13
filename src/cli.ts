import { loadConfig } from "./config/load.js";
import { ConfigError } from "./config/validate.js";
import { createProvider } from "./provider/factory.js";
import { SessionStore } from "./session/store.js";
import { ChatService } from "./chat/service.js";
import { startApp } from "./tui/index.js";

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

  const provider = createProvider(active);
  const store = new SessionStore();
  const chat = new ChatService(store, provider, active);

  console.log(
    `已加载配置（${loaded.source}），供应商：${active.name} / ${active.protocol} / ${active.model}`,
  );

  startApp({ store, chat, warnings: loaded.warnings });
}
