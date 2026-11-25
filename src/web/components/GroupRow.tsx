import { memo, useState, type KeyboardEvent, type MouseEvent } from "react";
import { groupKey, type InboxGroup } from "../../core/inbox.ts";
import type { WorkstreamPriority } from "../../core/workstream-placeholders.ts";
import { firstLine } from "../../core/pipeline/text.ts";
import {
  doneAllWorkstream,
  openWorkstreamSnooze,
  renameWorkstream,
  setWorkstreamPriority,
} from "../store/actions.ts";
import { useAppDispatch } from "../store/hooks.ts";
import { toggleWorkstream } from "../store/view.ts";
import { relativeTime, repoShortName } from "../format.ts";
import { anchorBelow } from "./SnoozeMenu.tsx";
import { rowDomId } from "./ThreadRow.tsx";
import rowStyles from "./ThreadRow.module.css";
import styles from "./GroupRow.module.css";

interface Props {
  group: InboxGroup;
  index: number;
  selected: boolean;
  expanded: boolean;
  now: number | null;
  onSelect: (key: string, index: number) => void;
}

const PRIORITY_LABELS: Record<WorkstreamPriority, string> = { normal: "Normal", low: "Low", muted: "Muted" };

export const GroupRow = memo(function GroupRow({ group, index, selected, expanded, now, onSelect }: Props) {
  const dispatch = useAppDispatch();
  const [editing, setEditing] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const key = groupKey(group.id);
  const count = group.members.length + group.moreCount;
  const doneCount = group.members.length;
  const summaryFirst = group.summary ? firstLine(group.summary.text) : "";
  const summaryMore = group.summary !== null && group.summary.text.trim() !== summaryFirst;

  const act = (e: MouseEvent, fn: () => void) => {
    e.stopPropagation();
    fn();
  };
  const finishRename = (value: string | null) => {
    setEditing(false);
    if (value !== null && value.trim() !== group.name) dispatch(renameWorkstream(group, value));
  };
  const onRenameKey = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === "Enter") finishRename(e.currentTarget.value);
    else if (e.key === "Escape") finishRename(null);
  };

  return (
    <li
      id={rowDomId(key)}
      role="option"
      aria-selected={selected}
      aria-expanded={expanded}
      className={`${rowStyles.row} ${styles.group} ${selected ? rowStyles.selected : ""} ${group.isNew ? rowStyles.unread : ""}`}
      onClick={() => onSelect(key, index)}
    >
      {!editing && (
        <div className={rowStyles.actions}>
          <select
            className={styles.priority}
            title="Workstream priority"
            value={group.priority}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => dispatch(setWorkstreamPriority(group, e.currentTarget.value as WorkstreamPriority))}
          >
            {(Object.keys(PRIORITY_LABELS) as WorkstreamPriority[]).map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABELS[p]}
              </option>
            ))}
          </select>
          <button type="button" title="Rename" onClick={(e) => act(e, () => setEditing(true))}>
            Rename
          </button>
          <button
            type="button"
            title="Snooze (s)"
            onClick={(e) => act(e, () => dispatch(openWorkstreamSnooze(group, anchorBelow(e.currentTarget))))}
          >
            Snooze
          </button>
          {group.section !== "hidden" && doneCount > 0 && (
            <button
              type="button"
              className={rowStyles.done}
              title="Mark the listed members done (e)"
              onClick={(e) => act(e, () => dispatch(doneAllWorkstream(group)))}
            >
              Done all ({doneCount})
            </button>
          )}
        </div>
      )}
      <div className={rowStyles.line}>
        <button
          type="button"
          className={styles.toggle}
          aria-label={expanded ? "Collapse workstream" : "Expand workstream"}
          title={expanded ? "Collapse (←)" : "Expand (→)"}
          onClick={(e) => act(e, () => dispatch(toggleWorkstream(group.id)))}
        >
          {expanded ? "▾" : "▸"}
        </button>
        <span className={rowStyles.repo}>{repoShortName(group.repo)}</span>
        {editing ? (
          <input
            className={styles.rename}
            defaultValue={group.name}
            aria-label="Workstream name"
            placeholder="Empty resets to the generated name"
            autoFocus
            onClick={(e) => e.stopPropagation()}
            onKeyDown={onRenameKey}
            onBlur={(e) => finishRename(e.currentTarget.value)}
          />
        ) : (
          <span className={rowStyles.title} title={group.name}>
            {group.name}
          </span>
        )}
        <span className={styles.count} title={`${count} pull requests and issues`}>
          {count}
        </span>
        {group.isNew && <span className={styles.newBadge}>new workstream</span>}
        {group.summary?.changed && <span className={styles.changed}>summary updated</span>}
        {group.priority !== "normal" && <span className={styles.badge}>{PRIORITY_LABELS[group.priority]}</span>}
        {group.closed && <span className={styles.badge}>closed</span>}
      </div>
      <div className={`${rowStyles.line} ${rowStyles.sub}`}>
        <span className={rowStyles.summary}>
          {group.summary?.status && <span className={styles.status}>{group.summary.status} · </span>}
          {summaryFirst || "No summary yet"}
        </span>
        {summaryMore && (
          <button
            type="button"
            className={styles.more}
            aria-expanded={summaryOpen}
            onClick={(e) => act(e, () => setSummaryOpen((open) => !open))}
          >
            {summaryOpen ? "less" : "more"}
          </button>
        )}
        {group.closedByAuthor > 0 && <span className={styles.closed}>{group.closedByAuthor} closed by author</span>}
        {now !== null && group.sortAt !== "" && (
          <span className={rowStyles.time}>{relativeTime(group.sortAt, now)}</span>
        )}
      </div>
      {summaryOpen && group.summary && <p className={styles.summaryText}>{group.summary.text}</p>}
    </li>
  );
});

interface FooterProps {
  group: InboxGroup;
  /** Listed members not shown because the expanded list is capped. */
  capped: number;
  onShowAll: (id: string) => void;
}

/** Closes an expanded workstream: the cap expander and a count of members the inbox does not list. */
export function GroupFooter({ group, capped, onShowAll }: FooterProps) {
  if (capped === 0 && group.moreCount === 0) return null;
  return (
    <li role="none" className={styles.footer}>
      {capped > 0 && (
        <button type="button" className={styles.more} onClick={() => onShowAll(group.id)}>
          and {capped} more
        </button>
      )}
      {group.moreCount > 0 && (
        <span title="Members in Hidden, or ones you are not involved in">
          {capped > 0 ? " · " : ""}
          {group.moreCount} more not listed
        </span>
      )}
    </li>
  );
}
