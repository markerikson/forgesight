import { Fragment, useCallback, useEffect } from "react";
import type { InboxRow } from "../../core/index.ts";
import {
  closedByAuthorLines,
  entryKey,
  hiddenActivityLine,
  hiddenActivitySince,
  type InboxEntry,
  isGroup,
} from "../../core/inbox.ts";
import { confirmDoneAll, doneKeys, markDone, openSnoozeMenu, toggleMute } from "../store/actions.ts";
import { useGetInboxQuery, usePrefetch } from "../store/api.ts";
import { useAppDispatch, useAppSelector } from "../store/hooks.ts";
import { SECTION_LABELS } from "../store/types.ts";
import {
  clickRow,
  inboxArgFor,
  MEMBER_CAP,
  rowSelected,
  selectGoneKeys,
  selectGroupOf,
  selectInbox,
  selectPollInterval,
  selectSelectedIndex,
  selectTopEntries,
  selectVisibleRows,
  selectView,
  workstreamShowAll,
} from "../store/view.ts";
import { repoShortName } from "../format.ts";
import { useHiddenSince } from "../hooks/useHiddenSince.ts";
import { useNow } from "../hooks/useNow.ts";
import { GroupFooter, GroupRow } from "./GroupRow.tsx";
import { anchorBelow } from "./SnoozeMenu.tsx";
import { rowDomId, ThreadRow } from "./ThreadRow.tsx";
import styles from "./ThreadList.module.css";

export { CONFIRM_DONE_ALL } from "../store/actions.ts";

/** Subject key worth prefetching for an entry; groups have no subject page. */
function subjectKeyOf(entry: InboxEntry | undefined): string | undefined {
  return entry && !isGroup(entry) ? entry.key : undefined;
}

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
  const hiddenSince = useHiddenSince(view.section === "hidden");

  const topEntries = useAppSelector(selectTopEntries);
  const groupOf = useAppSelector(selectGroupOf);

  const selectedEntry = rows[selectedIndex];
  const selectedKey = selectedEntry && entryKey(selectedEntry);
  const prevKey = subjectKeyOf(rows[selectedIndex - 1]);
  const nextKey = subjectKeyOf(rows[selectedIndex + 1]);

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

  const onSelect = useCallback((key: string, index: number) => dispatch(clickRow(key, index)), [dispatch]);
  const onDone = useCallback((row: InboxRow) => dispatch(markDone([row.key])), [dispatch]);
  const onMute = useCallback((row: InboxRow) => dispatch(toggleMute(row)), [dispatch]);
  const onSnooze = useCallback(
    (row: InboxRow, button: Element) => dispatch(openSnoozeMenu([row], anchorBelow(button))),
    [dispatch],
  );

  const onShowAll = useCallback((id: string) => dispatch(workstreamShowAll(id)), [dispatch]);

  // Dimmed rows already left the live list (and the sidebar count), so Done all skips them.
  const doneAllKeys = doneKeys(topEntries).filter((key) => !gone.has(key));
  const doneAll = () => {
    if (!confirmDoneAll(doneAllKeys.length)) return;
    dispatch(markDone(doneAllKeys));
  };

  let empty: string | null = null;
  if (isError && !inbox) empty = "Could not load the inbox.";
  else if (isLoading && !inbox) empty = "Loading…";
  else if (rows.length === 0) empty = `Nothing in ${SECTION_LABELS[view.section]}${view.repo ? ` for ${view.repo}` : ""}.`;

  const onHidden = view.section === "hidden";
  const activityLine =
    onHidden && inbox && hiddenSince !== null
      ? hiddenActivityLine(hiddenActivitySince(inbox.rows, hiddenSince, view.repo))
      : null;
  const closedLines = onHidden && inbox ? closedByAuthorLines(inbox.closedByAuthor, view.repo) : [];

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
      {activityLine !== null && <p className={styles.activity}>{activityLine}</p>}
      {empty !== null ? (
        <p className={styles.empty}>{empty}</p>
      ) : (
        <ul className={styles.rows} role="listbox" aria-label={SECTION_LABELS[view.section]}>
          {rows.map((row, index) => {
            if (isGroup(row)) {
              const expanded = view.expandedWorkstreams.includes(row.id);
              return (
                <Fragment key={entryKey(row)}>
                  <GroupRow
                    group={row}
                    index={index}
                    selected={index === selectedIndex}
                    expanded={expanded}
                    now={now}
                    onSelect={onSelect}
                  />
                  {expanded && row.members.length === 0 && (
                    <GroupFooter
                      group={row}
                      capped={0}
                      full={view.fullWorkstreams.includes(row.id)}
                      onShowAll={onShowAll}
                    />
                  )}
                </Fragment>
              );
            }
            const group = groupOf.get(row.key);
            const member = group !== undefined && view.expandedWorkstreams.includes(group.id);
            const next = rows[index + 1];
            const lastMember = member && (next === undefined || isGroup(next) || groupOf.get(next.key) !== group);
            return (
              <Fragment key={row.key}>
                <ThreadRow
                  row={row}
                  index={index}
                  selected={index === selectedIndex}
                  gone={gone.has(row.key)}
                  now={now}
                  onSelect={onSelect}
                  onDone={onDone}
                  onSnooze={onSnooze}
                  onMute={onMute}
                  member={member}
                />
                {lastMember && (
                  <GroupFooter
                    group={group}
                    capped={view.fullWorkstreams.includes(group.id) ? 0 : Math.max(0, group.members.length - MEMBER_CAP)}
                    full={view.fullWorkstreams.includes(group.id)}
                    onShowAll={onShowAll}
                  />
                )}
              </Fragment>
            );
          })}
        </ul>
      )}
      {closedLines.length > 0 && (
        <ul className={styles.countLines}>
          {closedLines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
