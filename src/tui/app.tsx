import React, { useMemo, useState } from "react";
import type { ChatService } from "../chat/service.js";
import type { SessionStore } from "../session/store.js";
import { ChatScreen } from "./chat-screen.js";
import { SessionPicker } from "./session-picker.js";

export interface AppProps {
  store: SessionStore;
  chat: ChatService;
  warnings: string[];
  sessionHooks?: {
    enter(sessionId: string): Promise<void>;
    leave(sessionId: string): Promise<void>;
  };
}

export function App({ store, chat, warnings, sessionHooks }: AppProps) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [listVersion, setListVersion] = useState(0);

  const sessions = useMemo(() => store.list(), [store, listVersion, sessionId]);

  if (!sessionId) {
    return (
      <SessionPicker
        sessions={sessions}
        onCreate={() => {
          const s = store.create();
          setListVersion((v) => v + 1);
          setSessionId(s.id);
        }}
        onSelect={(id) => setSessionId(id)}
      />
    );
  }

  return (
    <ChatScreen
      sessionId={sessionId}
      store={store}
      chat={chat}
      warnings={warnings}
      sessionHooks={sessionHooks}
      onBack={() => {
        setSessionId(null);
        setListVersion((v) => v + 1);
      }}
    />
  );
}
