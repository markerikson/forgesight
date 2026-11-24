import type { ReactNode } from "react";
import { useNow } from "../hooks/useNow.ts";
import { relativeTime } from "../format.ts";
import { POLL_MS, useGetStatusQuery } from "../store/api.ts";
import { useAppDispatch } from "../store/hooks.ts";
import { helpToggled } from "../store/view.ts";
import styles from "./StatusBar.module.css";

export function StatusBar() {
  const dispatch = useAppDispatch();
  const { data, isError } = useGetStatusQuery(undefined, { pollingInterval: POLL_MS });
  const now = useNow();
  const ago = (iso: string | null) => (iso === null ? "never" : now === null ? iso : `${relativeTime(iso, now)} ago`);

  let content: ReactNode = null;
  if (isError) {
    content = <span className={styles.bad}>Status unavailable: the last status check failed.</span>;
  } else if (data) {
    const { worker, viewer, poll, enrichQueue, backfill } = data;
    const workerText = worker.authFailed
      ? "auth failed"
      : worker.alive === null
        ? (worker.status ?? "unknown")
        : worker.alive
          ? "alive"
          : "stale";
    const workerClass = worker.authFailed || worker.alive === false ? styles.bad : worker.alive ? styles.ok : undefined;
    content = (
      <>
        <span className={workerClass}>Worker {workerText}</span>
        <span>{viewer.login ?? "unknown user"}</span>
        <span>Polled {ago(poll.lastPollStartedAt)}</span>
        {enrichQueue.pending > 0 && <span>{enrichQueue.pending} to refresh</span>}
        {enrichQueue.failing > 0 && <span className={styles.bad}>{enrichQueue.failing} failing</span>}
        {backfill.inProgress && <span>Backfilling</span>}
        <span>GraphQL {data.spend.graphql}/h</span>
        {data.configError && (
          <span className={styles.bad} title={data.configError}>
            Config error
          </span>
        )}
      </>
    );
  }

  return (
    <footer id="status-line" className={styles.bar}>
      {content}
      <button type="button" className={styles.help} onClick={() => dispatch(helpToggled())}>
        ? shortcuts
      </button>
    </footer>
  );
}
