import { Fragment, useEffect, useRef, useState } from "react";
import type { InboxRow, SubjectDetail, SubjectHeader } from "../../core/index.ts";
import { useNow } from "../hooks/useNow.ts";
import { REASON_LABELS, relativeTime } from "../format.ts";
import { keepNewFlags } from "../new-flags.ts";
import { isMuted, markDone, muteAndUnsubscribe, nextRow, openSnoozeMenu, toggleMute, toggleUnread } from "../store/actions.ts";
import { useGetStatusQuery, useGetSubjectQuery } from "../store/api.ts";
import { useAppDispatch, useAppSelector } from "../store/hooks.ts";
import { applyState } from "../store/state-api.ts";
import { rowRead, selectSelectedRow } from "../store/view.ts";
import { CiDot, DraftBadge, ReviewBadge, StateIcon } from "./Badges.tsx";
import { roundDomId, RoundView } from "./RoundView.tsx";
import { anchorBelow } from "./SnoozeMenu.tsx";
import styles from "./Preview.module.css";

/** True when opening the row should mark it read on GitHub and here. */
export function hasNewActivity(row: InboxRow): boolean {
  return row.unread || row.newMeaningfulCount > 0;
}

export function Preview() {
  const dispatch = useAppDispatch();
  const row = useAppSelector(selectSelectedRow);
  const { data, isError, isFetching } = useGetSubjectQuery(row?.key ?? "", { skip: !row });
  const loaded = data !== undefined && data.key === row?.key ? data : undefined;
  const me = useGetStatusQuery().data?.viewer.login ?? null;

  // The detail as it was when the user started reading this subject, so its "new" markers survive
  // the read and later refreshes. Selecting another subject replaces it.
  const [readingBase, setReadingBase] = useState<SubjectDetail | null>(null);
  if (loaded && readingBase?.key !== loaded.key) setReadingBase(loaded);

  const readKey = useRef<string | null>(null);
  useEffect(() => {
    if (!row || !loaded || readKey.current === row.key) return;
    readKey.current = row.key;
    if (!hasNewActivity(row)) return;
    dispatch(rowRead({ ...row, unread: false, newMeaningfulCount: 0 }));
    dispatch(applyState([row.key], { kind: "read" }));
  }, [dispatch, row, loaded]);

  if (!row) {
    return (
      <section className={styles.preview} aria-label="Preview">
        <p className={styles.message}>Pick a thread, or press j to start at the top.</p>
      </section>
    );
  }
  if (!loaded) {
    const message = isError ? "Could not load this thread." : isFetching ? "Loading…" : "";
    return (
      <section className={styles.preview} aria-label="Preview">
        <div className={styles.top}>
          <ActionBar row={row} url={row.url} />
        </div>
        <p className={styles.message}>{message}</p>
      </section>
    );
  }
  const subject = readingBase?.key === loaded.key ? keepNewFlags(readingBase, loaded, me) : loaded;
  return <SubjectPane subject={subject} row={row} />;
}

function ActionBar({ row, url }: { row: InboxRow; url: string | null }) {
  const dispatch = useAppDispatch();
  const [muteMenu, setMuteMenu] = useState(false);
  const muted = isMuted(row);

  return (
    <div className={styles.actions} role="toolbar" aria-label="Actions">
      <button
        type="button"
        className={styles.primary}
        disabled={row.section === "hidden"}
        title="Done (e)"
        onClick={() => dispatch(markDone([row.key]))}
      >
        Done
      </button>
      <button
        type="button"
        title={row.section === "snoozed" ? "Snooze or unsnooze (s)" : "Snooze (s)"}
        onClick={(e) => dispatch(openSnoozeMenu([row], anchorBelow(e.currentTarget)))}
      >
        Snooze…
      </button>
      <span className={styles.split}>
        <button type="button" title={muted ? "Unmute (m)" : "Mute (m)"} onClick={() => dispatch(toggleMute(row))}>
          {muted ? "Unmute" : "Mute"}
        </button>
        <button
          type="button"
          aria-label="More mute options"
          aria-haspopup="menu"
          aria-expanded={muteMenu}
          onClick={() => setMuteMenu((open) => !open)}
        >
          ▾
        </button>
        {muteMenu && (
          <>
            <div className={styles.backdrop} onClick={() => setMuteMenu(false)} />
            <div className={styles.menu} role="menu">
              <button
                type="button"
                role="menuitem"
                title="Mute here and unsubscribe on GitHub (Shift+M)"
                onClick={() => {
                  setMuteMenu(false);
                  dispatch(muteAndUnsubscribe(row));
                }}
              >
                Mute and unsubscribe
              </button>
            </div>
          </>
        )}
      </span>
      <button type="button" title={row.unread ? "Mark read (u)" : "Keep unread (u)"} onClick={() => dispatch(toggleUnread(row))}>
        {row.unread ? "Mark read" : "Keep unread"}
      </button>
      {url && (
        <a className={styles.button} href={url} target="_blank" rel="noopener noreferrer" title="Open on GitHub (o)">
          Open on GitHub
        </a>
      )}
      <button type="button" className={styles.next} title="Next thread (Space)" onClick={() => dispatch(nextRow())}>
        Next
      </button>
    </div>
  );
}

function SubjectPane({ subject, row }: { subject: SubjectDetail; row: InboxRow }) {
  const roundIndex = useAppSelector((state) => state.view.roundIndex);
  const now = useNow();
  const focused = Math.min(roundIndex, Math.max(subject.rounds.length - 1, 0));

  useEffect(() => {
    document.getElementById(roundDomId(subject.key, focused))?.scrollIntoView({ block: "nearest" });
  }, [subject.key, focused]);

  return (
    <section className={styles.preview} aria-label="Preview">
      <div className={styles.top}>
        <ActionBar row={row} url={subject.githubUrl ?? subject.header.url} />
        <Header header={subject.header} subject={subject} />
      </div>
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
  const notifiedFor = subject.reason !== "subscribed" ? subject.reason : null;
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
      {(subject.reasons.length > 0 || notifiedFor) && (
        <div className={styles.meta}>
          {notifiedFor && <span className={styles.reason}>notified: {notifiedFor.replaceAll("_", " ")}</span>}
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
