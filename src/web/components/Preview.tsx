import { Fragment, useEffect, useRef, useState } from "react";
import { hiddenReason, type InboxRow, type SubjectDetail, type SubjectHeader } from "../../core/index.ts";
import { useNow } from "../hooks/useNow.ts";
import { REASON_LABELS, relativeTime } from "../format.ts";
import { keepNewFlags } from "../new-flags.ts";
import {
  addToWorkstream,
  isMuted,
  markDone,
  markWorkstreamSeen,
  muteAndUnsubscribe,
  nextRow,
  openSnoozeMenu,
  toggleMute,
  toggleUnread,
} from "../store/actions.ts";
import { useGetStatusQuery, useGetSubjectQuery, useGetWorkstreamsQuery } from "../store/api.ts";
import { useAppDispatch, useAppSelector } from "../store/hooks.ts";
import { applyState, openSubject, refreshSubject } from "../store/state-api.ts";
import { groupOpened, rowRead, selectGroupOf, selectSelectedGroup, selectSelectedRow } from "../store/view.ts";
import { Avatar } from "./Avatar.tsx";
import { CiDot, DraftBadge, ReviewBadge, StateIcon } from "./Badges.tsx";
import { Description } from "./Description.tsx";
import { DiscussionMeta } from "./DiscussionMeta.tsx";
import { CopyFindings, FindingsPanel } from "./FindingsPanel.tsx";
import { roundDomId, RoundView } from "./RoundView.tsx";
import { anchorBelow } from "./SnoozeMenu.tsx";
import { GitHubIcon, SubjectLink } from "./SubjectLink.tsx";
import { subjectKeyForUrl } from "../links.ts";
import { StackBox, WorkstreamPane } from "./WorkstreamPreview.tsx";
import { WorkstreamPicker } from "./WorkstreamPicker.tsx";
import styles from "./Preview.module.css";

const FETCH_POLL_MS = 3000;

/** True when opening the row should mark it read on GitHub and here. */
export function hasNewActivity(row: InboxRow): boolean {
  return row.unread || row.newMeaningfulCount > 0;
}

export function Preview() {
  const dispatch = useAppDispatch();
  const row = useAppSelector(selectSelectedRow);
  const group = useAppSelector(selectSelectedGroup);
  // Polls while the subject is fetching: a fetch that fails or changes nothing in the derived view
  // sends no change event, so polling is what clears the loading state.
  const [polling, setPolling] = useState(false);
  const { data, isError, isFetching } = useGetSubjectQuery(row?.key ?? "", {
    skip: !row,
    pollingInterval: polling ? FETCH_POLL_MS : 0,
  });
  const loaded = data !== undefined && data.key === row?.key ? data : undefined;
  if ((loaded?.fetching === true) !== polling) setPolling(loaded?.fetching === true);
  const me = useGetStatusQuery().data?.viewer.login ?? null;

  const openedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!loaded || openedKey.current === loaded.key) return;
    openedKey.current = loaded.key;
    if (loaded.fetching) dispatch(openSubject(loaded.key));
  }, [dispatch, loaded]);

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

  // A workstream is marked seen when the user moves off it, not when it opens: seen groups lose
  // their place at the top of Updates, and reordering the list under the cursor is disorienting.
  // Moving between a group and its own members keeps it open.
  const parentGroup = useAppSelector((state) => (row ? selectGroupOf(state).get(row.key) : undefined));
  const currentGroup = group ?? parentGroup ?? null;
  const currentGroupId = currentGroup?.id ?? null;
  const openGroup = useRef<string | null>(null);
  useEffect(() => {
    const previous = openGroup.current;
    openGroup.current = currentGroupId;
    if (previous !== null && previous !== currentGroupId) dispatch(markWorkstreamSeen(previous));
  }, [dispatch, currentGroupId]);

  // An opened workstream keeps its place while the user reads it, even once reading its members
  // or marking it seen moves it out of this section.
  const lingering = useAppSelector(
    (state) => currentGroupId !== null && state.view.lingeringGroups.some((g) => g.id === currentGroupId),
  );
  useEffect(() => {
    if (currentGroup && !lingering) dispatch(groupOpened(currentGroup));
  }, [dispatch, currentGroup, lingering]);

  if (!row) {
    if (group) return <WorkstreamPane group={group} />;
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

function ActionBar({ row, url, subject }: { row: InboxRow; url: string | null; subject?: SubjectDetail }) {
  const dispatch = useAppDispatch();
  const [muteMenu, setMuteMenu] = useState(false);
  const muted = isMuted(row);

  return (
    <div className={styles.actions} role="toolbar" aria-label="Actions">
      <button
        type="button"
        className={styles.primary}
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
      {subject?.refreshable && (
        <button
          type="button"
          title="Fetch this thread from GitHub now"
          disabled={subject.fetching}
          onClick={() => dispatch(refreshSubject(row.key))}
        >
          {subject.fetching ? "Refreshing…" : "Refresh"}
        </button>
      )}
      {subject?.header.state === "OPEN" && <CopyFindings subject={subject} />}
      {subject && subject.workstream === null && <AddToWorkstream header={subject.header} />}
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

/** Joins an open pull request that has no workstream to one of its repo's workstreams. */
function AddToWorkstream({ header }: { header: SubjectHeader }) {
  const dispatch = useAppDispatch();
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  // A listed pull request that is not loaded yet has no state; the server checks it is open.
  const eligible =
    header.kind === "pr" && !header.merged && (header.state === null || header.state === "OPEN");
  const { data } = useGetWorkstreamsQuery(header.repo, { skip: !eligible });
  if (!eligible || !data?.workstreams.some((ws) => !ws.closed)) return null;
  return (
    <>
      <button
        type="button"
        title="Add this pull request to a workstream"
        onClick={(e) => setAnchor(anchorBelow(e.currentTarget))}
      >
        Add to workstream…
      </button>
      {anchor && (
        <WorkstreamPicker
          repo={header.repo}
          title={`Add #${header.number ?? ""} to…`}
          anchor={anchor}
          onChoose={(id, name) => dispatch(addToWorkstream(header.key, id, name))}
          onClose={() => setAnchor(null)}
        />
      )}
    </>
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
        <ActionBar row={row} url={subject.githubUrl ?? subject.header.url} subject={subject} />
        <Header header={subject.header} subject={subject} />
      </div>
      {subject.workstream && <StackBox workstream={subject.workstream} subjectKey={subject.key} />}
      {subject.body && <Description key={subject.key} body={subject.body} />}
      {subject.findings && <FindingsPanel findings={subject.findings} open={subject.header.state === "OPEN"} />}
      {subject.rounds.length === 0 && (
        <p className={styles.message}>{subject.fetching ? "Loading from GitHub…" : "No activity stored yet."}</p>
      )}
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
            <RoundView
              subjectKey={subject.key}
              round={round}
              index={index}
              focused={index === focused}
              now={now}
              answerId={subject.header.discussion?.answerId ?? null}
            />
          </Fragment>
        );
      })}
    </section>
  );
}

function Header({ header, subject }: { header: SubjectHeader; subject: SubjectDetail }) {
  const url = subject.githubUrl ?? header.url;
  const notifiedFor = subject.reason !== "subscribed" ? subject.reason : null;
  const reasons = subject.fetching ? subject.reasons.filter((reason) => reason !== "notEnriched") : subject.reasons;
  const hiddenWhy = hiddenReason({ ...subject, merged: header.merged });
  return (
    <header className={styles.header}>
      <h2 className={styles.title}>
        <StateIcon kind={header.kind} state={header.state} draft={header.draft} merged={header.merged} />
        <span>{header.title}</span>
        {url && <GitHubIcon url={url} />}
      </h2>
      <div className={styles.meta}>
        <span>
          {header.repo}
          {header.number !== null && `#${header.number}`}
        </span>
        {header.author && (
          <span>
            by <Avatar login={header.author} isBot={header.authorIsBot} /> {header.author}
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
        <DiscussionMeta info={header.discussion} />
        {subject.snoozeUntil && <span>snoozed until {subject.snoozeUntil.slice(0, 10)}</span>}
      </div>
      {(reasons.length > 0 || notifiedFor || subject.fetching || hiddenWhy) && (
        <div className={styles.meta}>
          {subject.fetching && <span className={styles.reason}>loading…</span>}
          {hiddenWhy && <span className={styles.hiddenWhy}>Hidden: {hiddenWhy}</span>}
          {notifiedFor && <span className={styles.reason}>notified: {notifiedFor.replaceAll("_", " ")}</span>}
          {reasons.map((reason) => (
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
          {subject.links.map((link) => {
            const key = subjectKeyForUrl(link.url);
            return (
              <li key={link.url}>
                {key ? (
                  <SubjectLink subjectKey={key} url={link.url}>
                    {link.label}
                  </SubjectLink>
                ) : (
                  <a href={link.url} target="_blank" rel="noopener noreferrer">
                    {link.label}
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </header>
  );
}
