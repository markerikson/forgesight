import { useCallback, useEffect } from "react";
import type { InboxRow } from "../../core/index.ts";
import { markDone, openSnoozeMenu, toggleMute } from "../store/actions.ts";
import { useGetInboxQuery, usePrefetch } from "../store/api.ts";
import { useAppDispatch, useAppSelector } from "../store/hooks.ts";
import { SECTION_LABELS } from "../store/types.ts";
import {
  inboxArgFor,
  rowSelected,
  selectGoneKeys,
  selectInbox,
  selectPollInterval,
  selectSelectedIndex,
  selectVisibleRows,
  selectView,
} from "../store/view.ts";
import { repoShortName } from "../format.ts";
import { useNow } from "../hooks/useNow.ts";
import { anchorBelow } from "./SnoozeMenu.tsx";
import { rowDomId, ThreadRow } from "./ThreadRow.tsx";
import styles from "./ThreadList.module.css";

/** "Done all" asks for confirmation above this many rows. */
export const CONFIRM_DONE_ALL = 20;

export function ThreadList() {
  const dispatch = useAppDispatch();
  const view = useAppSelector(selectView);
  const pollingInterval = useAppSelector(selectPollInterval);
  const { isError, isLoading } = useGetInboxQuery(inboxArgFor(view.section), { pollingInterval });
  const inbox = useAppSelector(selectInbox);
  const rows = useAppSelector(selectVisibleRows);
  const gone = useAppSelector(selectGoneKeys);
  const selectedIndex = useAppSelector(selectSelectedIndex);
  const prefetchSubject = usePrefetch("getSubject");
  const now = useNow();

  const selectedKey = rows[selectedIndex]?.key;
  const prevKey = rows[selectedIndex - 1]?.key;
  const nextKey = rows[selectedIndex + 1]?.key;

  // Store the row actually shown as selected (the implicit first row, or the neighbor that replaced a
  // row that left the list), so later polls that insert or remove rows don't move the selection.
  useEffect(() => {
    if (selectedKey !== undefined && (selectedKey !== view.selectedKey || selectedIndex !== view.selectedIndex)) {
      dispatch(rowSelected({ key: selectedKey, index: selectedIndex }));
    }
  }, [dispatch, selectedKey, selectedIndex, view.selectedKey, view.selectedIndex]);

  useEffect(() => {
    if (selectedKey) document.getElementById(rowDomId(selectedKey))?.scrollIntoView({ block: "nearest" });
  }, [selectedKey]);

  useEffect(() => {
    if (prevKey) prefetchSubject(prevKey);
    if (nextKey) prefetchSubject(nextKey);
  }, [prevKey, nextKey, prefetchSubject]);

  const onSelect = useCallback((key: string, index: number) => dispatch(rowSelected({ key, index })), [dispatch]);
  const onDone = useCallback((row: InboxRow) => dispatch(markDone([row.key])), [dispatch]);
  const onMute = useCallback((row: InboxRow) => dispatch(toggleMute(row)), [dispatch]);
  const onSnooze = useCallback(
    (row: InboxRow, button: Element) => dispatch(openSnoozeMenu([row], anchorBelow(button))),
    [dispatch],
  );

  // Dimmed rows already left the live list (and the sidebar count), so Done all skips them.
  const doneAllKeys = rows.filter((row) => !gone.has(row.key)).map((row) => row.key);
  const doneAll = () => {
    const keys = doneAllKeys;
    if (keys.length > CONFIRM_DONE_ALL && !window.confirm(`Mark all ${keys.length} items done?`)) return;
    dispatch(markDone(keys));
  };

  let empty: string | null = null;
  if (isError && !inbox) empty = "Could not load the inbox.";
  else if (isLoading && !inbox) empty = "Loading…";
  else if (rows.length === 0) empty = `Nothing in ${SECTION_LABELS[view.section]}${view.repo ? ` for ${view.repo}` : ""}.`;

  return (
    <section className={styles.list} aria-label="Threads">
      <header className={styles.header}>
        <span className={styles.heading}>
          {SECTION_LABELS[view.section]}
          {view.repo && <span className={styles.repo}> · {repoShortName(view.repo)}</span>}
        </span>
        {doneAllKeys.length > 0 && (
          <button type="button" className={styles.doneAll} onClick={doneAll}>
            Done all ({doneAllKeys.length})
          </button>
        )}
      </header>
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
              gone={gone.has(row.key)}
              now={now}
              onSelect={onSelect}
              onDone={onDone}
              onSnooze={onSnooze}
              onMute={onMute}
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
