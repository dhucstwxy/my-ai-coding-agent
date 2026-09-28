import React from "react";
import { render } from "ink";
import type { ChatService } from "../chat/service.js";
import type { SessionStore } from "../session/store.js";
import { App } from "./app.js";

export interface StartAppDeps {
  store: SessionStore;
  chat: ChatService;
  warnings: string[];
  sessionHooks?: {
    enter(sessionId: string): Promise<void>;
    leave(sessionId: string): Promise<void>;
  };
}

/** 挂载 Ink TUI */
export function startApp(deps: StartAppDeps) {
  return render(
    <App
      store={deps.store}
      chat={deps.chat}
      warnings={deps.warnings}
      sessionHooks={deps.sessionHooks}
    />,
  );
}
