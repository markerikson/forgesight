"use client";

import { useEffect, useState } from "react";
import { Provider } from "react-redux";
import type { StatusPayload } from "../server/handlers/status.ts";
import { HelpOverlay } from "./components/HelpOverlay.tsx";
import { Preview } from "./components/Preview.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { ThreadList } from "./components/ThreadList.tsx";
import { useKeyboardNav } from "./hooks/useKeyboardNav.ts";
import { useUrlState } from "./hooks/useUrlState.ts";
import { makeStore, setupListeners } from "./store/index.ts";
import type { InboxPayload } from "../core/index.ts";
import styles from "./InboxApp.module.css";

interface Props {
  initialStatus: StatusPayload;
  initialInbox?: InboxPayload | undefined;
}

export function InboxApp({ initialStatus, initialInbox }: Props) {
  const [store] = useState(() => makeStore({ status: initialStatus, inbox: initialInbox }));
  useEffect(() => setupListeners(store.dispatch), [store]);
  return (
    <Provider store={store}>
      <Inbox />
    </Provider>
  );
}

function Inbox() {
  useKeyboardNav();
  useUrlState();
  return (
    <div className={styles.app}>
      <Sidebar />
      <ThreadList />
      <Preview />
      <StatusBar />
      <HelpOverlay />
    </div>
  );
}
