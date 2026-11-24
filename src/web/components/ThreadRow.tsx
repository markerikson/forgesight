import { memo } from "react";
import type { InboxRow } from "../../core/index.ts";
import { relativeTime, repoShortName } from "../format.ts";
import { CiDot, DraftBadge, ReviewBadge, StateIcon } from "./Badges.tsx";
import styles from "./ThreadRow.module.css";

interface Props {
  row: InboxRow;
  index: number;
  selected: boolean;
  now: number | null;
  onSelect: (key: string, index: number) => void;
}

export const ThreadRow = memo(function ThreadRow({ row, index, selected, now, onSelect }: Props) {
  return (
    <li
      id={rowDomId(row.key)}
      role="option"
      aria-selected={selected}
      className={`${styles.row} ${selected ? styles.selected : ""} ${row.unread ? styles.unread : ""}`}
      onClick={() => onSelect(row.key, index)}
    >
      <div className={styles.line}>
        <StateIcon kind={row.kind} state={row.state} draft={row.draft} merged={row.merged} />
        <span className={styles.repo}>
          {repoShortName(row.repo)}
          {row.number !== null && `#${row.number}`}
        </span>
        <span className={styles.title} title={row.title}>
          {row.title}
        </span>
        <DraftBadge draft={row.draft} />
        <CiDot state={row.ciState} />
        <ReviewBadge decision={row.reviewDecision} />
        {row.newMeaningfulCount > 0 && (
          <span className={styles.newCount} title={`${row.newMeaningfulCount} new`}>
            {row.newMeaningfulCount}
          </span>
        )}
      </div>
      <div className={`${styles.line} ${styles.sub}`}>
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
