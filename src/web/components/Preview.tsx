import { Fragment, useEffect } from "react";
import type { SubjectDetail, SubjectHeader } from "../../core/index.ts";
import { useNow } from "../hooks/useNow.ts";
import { REASON_LABELS, relativeTime } from "../format.ts";
import { useGetSubjectQuery } from "../store/api.ts";
import { useAppSelector } from "../store/hooks.ts";
import { selectSelectedRow } from "../store/view.ts";
import { CiDot, DraftBadge, ReviewBadge, StateIcon } from "./Badges.tsx";
import { roundDomId, RoundView } from "./RoundView.tsx";
import styles from "./Preview.module.css";

export function Preview() {
  const row = useAppSelector(selectSelectedRow);
  const { data, isError, isFetching } = useGetSubjectQuery(row?.key ?? "", { skip: !row });

  if (!row) return <section className={styles.preview} aria-label="Preview" />;
  if (!data || data.key !== row.key) {
    const message = isError ? "Could not load this thread." : isFetching ? "Loading…" : "";
    return (
      <section className={styles.preview} aria-label="Preview">
        <p className={styles.message}>{message}</p>
      </section>
    );
  }
  return <SubjectPane subject={data} />;
}

function SubjectPane({ subject }: { subject: SubjectDetail }) {
  const roundIndex = useAppSelector((state) => state.view.roundIndex);
  const now = useNow();
  const focused = Math.min(roundIndex, Math.max(subject.rounds.length - 1, 0));

  useEffect(() => {
    document.getElementById(roundDomId(subject.key, focused))?.scrollIntoView({ block: "nearest" });
  }, [subject.key, focused]);

  return (
    <section className={styles.preview} aria-label="Preview">
      <Header header={subject.header} subject={subject} />
      {subject.rounds.length === 0 && <p className={styles.message}>No activity stored yet.</p>}
      {subject.rounds.map((round, index) => {
        const prev = subject.rounds[index - 1];
        const marker = prev !== undefined && prev.isNew && !round.isNew;
        return (
          <Fragment key={round.startedBy?.id ?? `first-${round.startedAt}`}>
            {marker && (
              <div className={styles.lastVisit} role="separator">
                <span>
                  Last visit
                  {subject.lastVisitAt && now !== null ? ` · ${relativeTime(subject.lastVisitAt, now)} ago` : ""}
                </span>
              </div>
            )}
            <RoundView subjectKey={subject.key} round={round} index={index} focused={index === focused} now={now} />
          </Fragment>
        );
      })}
    </section>
  );
}

function Header({ header, subject }: { header: SubjectHeader; subject: SubjectDetail }) {
  const url = subject.githubUrl ?? header.url;
  return (
    <header className={styles.header}>
      <h2 className={styles.title}>
        <StateIcon kind={header.kind} state={header.state} draft={header.draft} merged={header.merged} />
        {url ? (
          <a href={url} target="_blank" rel="noopener noreferrer">
            {header.title}
          </a>
        ) : (
          header.title
        )}
      </h2>
      <div className={styles.meta}>
        <span>
          {header.repo}
          {header.number !== null && `#${header.number}`}
        </span>
        {header.author && (
          <span>
            by {header.author}
            {header.authorIsBot && " (bot)"}
          </span>
        )}
        {header.headRef && header.baseRef && (
          <span className={styles.branch}>
            {header.headRef} → {header.baseRef}
          </span>
        )}
        <DraftBadge draft={header.draft} />
        <CiDot state={header.ciState} />
        <ReviewBadge decision={header.reviewDecision} />
        {subject.snoozeUntil && <span>snoozed until {subject.snoozeUntil.slice(0, 10)}</span>}
      </div>
      {(subject.reasons.length > 0 || subject.reason) && (
        <div className={styles.meta}>
          {subject.reason && <span className={styles.reason}>notified: {subject.reason}</span>}
          {subject.reasons.map((reason) => (
            <span key={reason} className={styles.reason}>
              {REASON_LABELS[reason]}
            </span>
          ))}
        </div>
      )}
      {header.labels.length > 0 && (
        <ul className={styles.labels}>
          {header.labels.map((label) => (
            <li key={label}>{label}</li>
          ))}
        </ul>
      )}
      {header.enrichError && <p className={styles.error}>Last refresh failed: {header.enrichError}</p>}
      {subject.links.length > 0 && (
        <ul className={styles.links}>
          {subject.links.map((link) => (
            <li key={link.url}>
              <a href={link.url} target="_blank" rel="noopener noreferrer">
                {link.label}
              </a>
            </li>
          ))}
        </ul>
      )}
    </header>
  );
}
