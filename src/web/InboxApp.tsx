"use client";

import { useEffect, useState } from "react";
import { Provider } from "react-redux";
import type { StatusPayload } from "../server/handlers/status.ts";
import { POLL_MS, useGetStatusQuery } from "./store/api.ts";
import { makeStore, setupListeners } from "./store/index.ts";

export function InboxApp({ initialStatus }: { initialStatus: StatusPayload }) {
  const [store] = useState(() => makeStore({ status: initialStatus }));
  useEffect(() => setupListeners(store.dispatch), [store]);
  return (
    <Provider store={store}>
      <StatusLine />
    </Provider>
  );
}

function StatusLine() {
  const { data, isError } = useGetStatusQuery(undefined, { pollingInterval: POLL_MS });
  if (isError) return <p id="status-line">Status unavailable: the last status check failed.</p>;
  if (!data) return null;
  const { worker, viewer, poll } = data;
  const workerText =
    worker.authFailed ? "auth failed" : worker.alive === null ? (worker.status ?? "unknown") : worker.alive ? "alive" : "stale";
  return (
    <p id="status-line">
      Worker: {workerText} · Viewer: {viewer.login ?? "unknown"} · Last poll: {poll.lastPollStartedAt ?? "never"} ·
      GraphQL spend (1h): {data.spend.graphql}
    </p>
  );
}
