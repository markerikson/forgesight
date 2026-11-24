import type { Round } from "../../core/index.ts";
import { relativeTime } from "../format.ts";
import { CollapsedGroup } from "./CollapsedGroup.tsx";
import { EventItem } from "./EventItem.tsx";
import styles from "./RoundView.module.css";

interface Props {
  subjectKey: string;
  round: Round;
  index: number;
  focused: boolean;
  now: number | null;
}

export function roundDomId(subjectKey: string, index: number): string {
  return `round-${subjectKey.replace(/[^A-Za-z0-9_-]/g, "_")}-${index}`;
}

export function RoundView({ subjectKey, round, index, focused, now }: Props) {
  const label = round.startLabel ?? (round.startedBy ? "New round" : "Earlier");
  return (
    <section
      id={roundDomId(subjectKey, index)}
      className={`${styles.round} ${focused ? styles.focused : ""}`}
      aria-label={label}
    >
      <header className={styles.header}>
        <span className={styles.label}>{label}</span>
        {round.isNew && <span className={styles.newTag}>new</span>}
        {round.hiddenCount > 0 && <span className={styles.hidden}>{round.hiddenCount} hidden</span>}
        {now !== null && (
          <time className={styles.time} dateTime={round.startedAt} title={round.startedAt}>
            {relativeTime(round.startedAt, now)}
          </time>
        )}
      </header>
      <div className={styles.entries}>
        {round.entries.map((entry) =>
          entry.type === "event" ? (
            <EventItem key={entry.event.id} event={entry.event} now={now} withBody={entry.event.level === "show"} />
          ) : (
            <CollapsedGroup
              key={entry.group.items[0]?.id ?? entry.group.summary}
              subjectKey={subjectKey}
              group={entry.group}
              now={now}
            />
          ),
        )}
        {round.entries.length === 0 && round.pushCount <= 1 && <p className={styles.empty}>No visible activity.</p>}
      </div>
    </section>
  );
}
