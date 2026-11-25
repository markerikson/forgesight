import { memo, type MouseEvent } from "react";
import type { InboxRow } from "../../core/index.ts";
import { isMuted } from "../store/actions.ts";
import { relativeTime, repoShortName } from "../format.ts";
import { CiDot, DraftBadge, ReviewBadge, StateIcon } from "./Badges.tsx";
import styles from "./ThreadRow.module.css";

interface Props {
  row: InboxRow;
  index: number;
  selected: boolean;
  /** Read in this session and gone from the live list; still shown, dimmed, until the view changes. */
  gone: boolean;
  now: number | null;
  onSelect: (key: string, index: number) => void;
  onDone: (row: InboxRow) => void;
  onSnooze: (row: InboxRow, button: Element) => void;
  onMute: (row: InboxRow) => void;
  /** Listed under an expanded workstream group. */
  member?: boolean;
}

export const ThreadRow = memo(function ThreadRow({
  row,
  index,
  selected,
  gone,
  now,
  onSelect,
  onDone,
  onSnooze,
  onMute,
  member = false,
}: Props) {
  const muted = isMuted(row);
  const act = (e: MouseEvent, fn: () => void) => {
    e.stopPropagation();
    fn();
  };
  return (
    <li
      id={rowDomId(row.key)}
      role="option"
      aria-selected={selected}
      className={`${styles.row} ${selected ? styles.selected : ""} ${row.unread ? styles.unread : ""} ${gone ? styles.gone : ""} ${member ? styles.member : ""}`}
      onClick={() => onSelect(row.key, index)}
    >
      <div className={styles.actions}>
        <button type="button" title="Snooze (s)" onClick={(e) => act(e, () => onSnooze(row, e.currentTarget))}>
          Snooze
        </button>
        <button type="button" title={muted ? "Unmute (m)" : "Mute (m)"} onClick={(e) => act(e, () => onMute(row))}>
          {muted ? "Unmute" : "Mute"}
        </button>
        <button type="button" className={styles.done} title="Done (e)" onClick={(e) => act(e, () => onDone(row))}>
          Done
        </button>
      </div>
      <div className={styles.line}>
        <StateIcon kind={row.kind} state={row.state} draft={row.draft} merged={row.merged} />
        <span className={styles.repo}>
          {repoShortName(row.repo)}
          {row.number !== null && `#${row.number}`}
        </span>
        {row.newMeaningfulCount > 0 && (
          <span className={styles.newCount} title={`${row.newMeaningfulCount} new`}>
            {row.newMeaningfulCount}
          </span>
        )}
        <span className={styles.title} title={row.title}>
          {row.title}
        </span>
        <DraftBadge draft={row.draft} />
        <CiDot state={row.ciState} />
        <ReviewBadge decision={row.reviewDecision} />
      </div>
      <div className={`${styles.line} ${styles.sub}`}>
        {row.author && (
          <span className={styles.author} title={`Opened by ${row.author}`}>
            {row.author}
          </span>
        )}
        <span className={styles.summary}>{row.summaryLine}</span>
        {row.enrichError && (
          <span className={styles.stale} title={row.enrichError}>
            stale
          </span>
        )}
        {row.latestActor && <span className={styles.actor}>{row.latestActor}</span>}
        {now !== null && <span className={styles.time}>{relativeTime(row.sortAt, now)}</span>}
      </div>
    </li>
  );
});

export function rowDomId(key: string): string {
  return `row-${key.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}
