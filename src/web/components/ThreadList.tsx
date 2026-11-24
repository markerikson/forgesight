import { useCallback, useEffect } from "react";
import { POLL_MS, useGetInboxQuery, usePrefetch } from "../store/api.ts";
import { useAppDispatch, useAppSelector } from "../store/hooks.ts";
import { SECTION_LABELS } from "../store/types.ts";
import { inboxArgFor, rowSelected, selectInbox, selectSelectedIndex, selectVisibleRows, selectView } from "../store/view.ts";
import { useNow } from "../hooks/useNow.ts";
import { rowDomId, ThreadRow } from "./ThreadRow.tsx";
import styles from "./ThreadList.module.css";

export function ThreadList() {
  const dispatch = useAppDispatch();
  const view = useAppSelector(selectView);
  const { isError, isLoading } = useGetInboxQuery(inboxArgFor(view.section), { pollingInterval: POLL_MS });
  const inbox = useAppSelector(selectInbox);
  const rows = useAppSelector(selectVisibleRows);
  const selectedIndex = useAppSelector(selectSelectedIndex);
  const prefetchSubject = usePrefetch("getSubject");
  const now = useNow();

  const selectedKey = rows[selectedIndex]?.key;
  const prevKey = rows[selectedIndex - 1]?.key;
  const nextKey = rows[selectedIndex + 1]?.key;

  useEffect(() => {
    if (selectedKey) document.getElementById(rowDomId(selectedKey))?.scrollIntoView({ block: "nearest" });
  }, [selectedKey]);

  useEffect(() => {
    if (prevKey) prefetchSubject(prevKey);
    if (nextKey) prefetchSubject(nextKey);
  }, [prevKey, nextKey, prefetchSubject]);

  const onSelect = useCallback((key: string, index: number) => dispatch(rowSelected({ key, index })), [dispatch]);

  let empty: string | null = null;
  if (isError && !inbox) empty = "Could not load the inbox.";
  else if (isLoading && !inbox) empty = "Loading…";
  else if (rows.length === 0) empty = `Nothing in ${SECTION_LABELS[view.section]}${view.repo ? ` for ${view.repo}` : ""}.`;

  return (
    <section className={styles.list} aria-label="Threads">
      {empty !== null ? (
        <p className={styles.empty}>{empty}</p>
      ) : (
        <ul className={styles.rows} role="listbox" aria-label={SECTION_LABELS[view.section]}>
          {rows.map((row, index) => (
            <ThreadRow
              key={row.key}
              row={row}
              index={index}
              selected={index === selectedIndex}
              now={now}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
      {inbox && inbox.countLines.length > 0 && (
        <ul className={styles.countLines}>
          {inbox.countLines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
