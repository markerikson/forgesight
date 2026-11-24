import { useState, type ReactNode } from "react";
import { useNow } from "../hooks/useNow.ts";
import { relativeTime } from "../format.ts";
import { useGetStatusQuery } from "../store/api.ts";
import { useAppDispatch, useAppSelector } from "../store/hooks.ts";
import { refreshNow, undoOp } from "../store/state-api.ts";
import { helpToggled, selectPollInterval, type Connection } from "../store/view.ts";
import styles from "./StatusBar.module.css";

export interface OutboxStatus {
  pending: number;
  failed: number;
  lastError: string | null;
}

/** Reads the outbox summary when the server sends one; older servers omit it. */
export function readOutbox(data: object): OutboxStatus | null {
  if (!("outbox" in data)) return null;
  const outbox = data.outbox;
  if (typeof outbox !== "object" || outbox === null) return null;
  if (!("pending" in outbox) || typeof outbox.pending !== "number") return null;
  if (!("failed" in outbox) || typeof outbox.failed !== "number") return null;
  const lastError = "lastError" in outbox && typeof outbox.lastError === "string" ? outbox.lastError : null;
  return { pending: outbox.pending, failed: outbox.failed, lastError };
}

const CONNECTION_TEXT: Record<Connection, string> = {
  open: "Live",
  connecting: "Reconnecting…",
  closed: "Polling",
};

export function StatusBar() {
  const dispatch = useAppDispatch();
  const pollingInterval = useAppSelector(selectPollInterval);
  const connection = useAppSelector((state) => state.view.connection);
  const { data, isError } = useGetStatusQuery(undefined, { pollingInterval });
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
    const outbox = readOutbox(data);
    content = (
      <>
        <span className={workerClass}>Worker {workerText}</span>
        <span>{viewer.login ?? "unknown user"}</span>
        <span>Polled {ago(poll.lastPollStartedAt)}</span>
        {enrichQueue.pending > 0 && <span>{enrichQueue.pending} to refresh</span>}
        {enrichQueue.failing > 0 && <span className={styles.bad}>{enrichQueue.failing} failing</span>}
        {backfill.inProgress && <span>Backfilling</span>}
        {outbox && outbox.pending > 0 && <span>Outbox: {outbox.pending} pending</span>}
        {outbox && outbox.failed > 0 && (
          <span className={styles.warn} title={outbox.lastError ?? undefined}>
            Outbox: {outbox.failed} failed to reach GitHub
          </span>
        )}
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
      <span className={connection === "open" ? styles.ok : undefined} title="Live updates from the server">
        {CONNECTION_TEXT[connection]}
      </span>
      {content}
      <span className={styles.controls}>
        <button type="button" className={styles.button} title="Check GitHub now (Shift+R)" onClick={() => dispatch(refreshNow())}>
          Refresh
        </button>
        <UndoButton />
        <button type="button" className={styles.button} onClick={() => dispatch(helpToggled())}>
          ? shortcuts
        </button>
      </span>
    </footer>
  );
}

function UndoButton() {
  const dispatch = useAppDispatch();
  const undo = useAppSelector((state) => state.view.undo);
  const [open, setOpen] = useState(false);
  const now = useNow();
  if (undo.length === 0) return null;
  return (
    <>
      <button
        type="button"
        className={styles.button}
        title="Undo a recent change (Shift+Z undoes the latest)"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Undo ({undo.length})
      </button>
      {open && (
        <div className={styles.backdrop} onClick={() => setOpen(false)}>
          <ul className={styles.undoMenu} role="menu" aria-label="Recent changes" onClick={(e) => e.stopPropagation()}>
            {undo.map((entry) => (
              <li key={entry.opId}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    dispatch(undoOp(entry.opId));
                  }}
                >
                  <span>Undo: {entry.label}</span>
                  {now !== null && <span className={styles.when}>{relativeTime(entry.at, now)} ago</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
