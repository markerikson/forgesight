import type { GroupSummary, InboxGroup, SubjectWorkstream } from "../../core/inbox.ts";
import type { SubjectKey } from "../../core/types.ts";
import type { WsPriority as WorkstreamPriority } from "../../core/workstream-state.ts";
import { relativeTime, repoShortName } from "../format.ts";
import { useNow } from "../hooks/useNow.ts";
import {
  doneAllWorkstream,
  doneKeys,
  openWorkstreamSnooze,
  renameWorkstream,
  setWorkstreamPriority,
} from "../store/actions.ts";
import { useAppDispatch, useAppSelector } from "../store/hooks.ts";
import { selectGoneKeys, selectSubject } from "../store/view.ts";
import { anchorBelow } from "./SnoozeMenu.tsx";
import { StateIcon } from "./Badges.tsx";
import { UNLISTED_LABELS } from "./GroupRow.tsx";
import previewStyles from "./Preview.module.css";
import styles from "./WorkstreamPreview.module.css";

const PRIORITIES: { value: WorkstreamPriority; label: string; title: string }[] = [
  { value: "normal", label: "Normal", title: "Show in Waiting or Updates like its members" },
  { value: "low", label: "Low", title: "Stay collapsed in Updates; new PRs do not raise it" },
  { value: "muted", label: "Muted", title: "Move to Hidden; review requests and mentions still show" },
];

/** GitHub redirects /issues/N to the pull request when N is one. */
function githubUrlFor(key: SubjectKey): string | null {
  const match = /^([^#@]+)#(\d+)$/.exec(key);
  return match ? `https://github.com/${match[1]}/issues/${match[2]}` : null;
}

function keyLabel(key: SubjectKey): string {
  const hash = key.indexOf("#");
  return hash === -1 ? key : `#${key.slice(hash + 1)}`;
}

function SummaryBlock({ summary }: { summary: GroupSummary | null }) {
  const now = useNow();
  if (!summary) return <p className={styles.noSummary}>No summary yet.</p>;
  return (
    <div className={styles.summary}>
      {summary.status && <p className={styles.status}>{summary.status}</p>}
      <p className={styles.summaryText}>{summary.text}</p>
      <p className={styles.generated}>
        {summary.changed && <span className={styles.changed}>updated since you last looked · </span>}
        {now !== null && `summarized ${relativeTime(summary.generatedAt, now)} ago`}
      </p>
    </div>
  );
}

function StackLink({ subjectKey, title }: { subjectKey: SubjectKey; title: string | undefined }) {
  const dispatch = useAppDispatch();
  const url = githubUrlFor(subjectKey);
  const label = title ? `${keyLabel(subjectKey)} ${title}` : keyLabel(subjectKey);
  return (
    <button
      type="button"
      className={styles.link}
      title={title ?? subjectKey}
      onClick={() => {
        if (!dispatch(selectSubject(subjectKey)) && url) window.open(url, "_blank", "noopener,noreferrer");
      }}
    >
      {label}
    </button>
  );
}

/** Where the open subject sits in its stack, and what the workstream is about. */
export function StackBox({ workstream }: { workstream: SubjectWorkstream }) {
  const { stack, titles } = workstream;
  return (
    <section className={styles.stack} aria-label="Stack">
      <div className={styles.stackHead}>
        <span className={styles.stackName}>{workstream.name}</span>
        <span className={styles.position}>
          {stack.position} of {stack.size} in stack
        </span>
      </div>
      <dl className={styles.relations}>
        <dt>Based on</dt>
        <dd>{stack.parent ? <StackLink subjectKey={stack.parent} title={titles[stack.parent]} /> : "the base branch"}</dd>
        {stack.children.length > 0 && (
          <>
            <dt>Next</dt>
            <dd>
              {stack.children.map((child) => (
                <StackLink key={child} subjectKey={child} title={titles[child]} />
              ))}
            </dd>
          </>
        )}
      </dl>
      {workstream.summary && <SummaryBlock summary={workstream.summary} />}
    </section>
  );
}

/** Every member the inbox knows about, listed or not, in stack order. */
function stackOrder(group: InboxGroup) {
  const listed = new Map(group.members.map((m) => [m.key, m]));
  const unlisted = new Map(group.unlisted.map((m) => [m.key, m]));
  return group.memberKeys
    .map((key) => ({ key, member: listed.get(key), unlisted: unlisted.get(key) }))
    .filter((entry) => entry.member !== undefined || entry.unlisted !== undefined);
}

/** Preview of a selected workstream row: summary, state controls and the whole stack. */
export function WorkstreamPane({ group }: { group: InboxGroup }) {
  const dispatch = useAppDispatch();
  const now = useNow();
  const stack = stackOrder(group);
  const gone = useAppSelector(selectGoneKeys);
  const doneCount = doneKeys([group], gone).length;
  const rename = () => {
    const name = window.prompt("Workstream name (empty resets to the generated name)", group.name);
    if (name !== null && name.trim() !== group.name) dispatch(renameWorkstream(group, name));
  };

  return (
    <section className={previewStyles.preview} aria-label="Preview">
      <div className={previewStyles.top}>
        <div className={previewStyles.actions} role="toolbar" aria-label="Workstream actions">
          <button
            type="button"
            className={previewStyles.primary}
            disabled={group.section === "hidden" || doneCount === 0}
            title="Mark the listed members done (e)"
            onClick={() => dispatch(doneAllWorkstream(group))}
          >
            Done all ({doneCount})
          </button>
          <button
            type="button"
            title="Snooze (s)"
            onClick={(e) => dispatch(openWorkstreamSnooze(group, anchorBelow(e.currentTarget)))}
          >
            Snooze…
          </button>
          <span className={styles.priority} role="radiogroup" aria-label="Priority">
            {PRIORITIES.map((p) => (
              <button
                key={p.value}
                type="button"
                role="radio"
                aria-checked={group.priority === p.value}
                className={group.priority === p.value ? styles.active : ""}
                title={p.title}
                onClick={() => {
                  if (group.priority !== p.value) dispatch(setWorkstreamPriority(group, p.value));
                }}
              >
                {p.label}
              </button>
            ))}
          </span>
          <button type="button" onClick={rename}>
            Rename…
          </button>
        </div>
        <header className={previewStyles.header}>
          <h2 className={previewStyles.title}>{group.name}</h2>
          <div className={previewStyles.meta}>
            <span>{group.repo}</span>
            <span>
              {group.members.length + group.moreCount} pull requests and issues
              {group.moreCount > 0 && ` (${group.moreCount} not listed)`}
            </span>
            {group.isNew && <span className={styles.newBadge}>new workstream</span>}
            {group.closed && <span>closed</span>}
            {group.snoozeUntil && <span>snoozed until {group.snoozeUntil.slice(0, 10)}</span>}
            {group.closedByAuthor > 0 && <span>{group.closedByAuthor} closed by author</span>}
          </div>
        </header>
      </div>
      <div className={styles.body}>
        <SummaryBlock summary={group.summary} />
        {stack.length > 0 && (
          <ol className={styles.members}>
            {stack.map(({ key, member, unlisted }) =>
              member ? (
                <li key={key}>
                  <button type="button" className={styles.member} onClick={() => dispatch(selectSubject(member.key))}>
                    <StateIcon kind={member.kind} state={member.state} draft={member.draft} merged={member.merged} />
                    <span className={styles.memberNumber}>
                      {repoShortName(member.repo)}#{member.number}
                    </span>
                    <span className={styles.memberTitle}>{member.title}</span>
                    {member.newMeaningfulCount > 0 && (
                      <span className={styles.memberNew}>{member.newMeaningfulCount} new</span>
                    )}
                    {now !== null && <span className={styles.memberTime}>{relativeTime(member.sortAt, now)}</span>}
                  </button>
                </li>
              ) : unlisted ? (
                <li key={key}>
                  <a
                    className={`${styles.member} ${styles.unlisted}`}
                    href={unlisted.url ?? undefined}
                    target="_blank"
                    rel="noreferrer"
                    title="Opens on GitHub"
                  >
                    <StateIcon kind="pr" state={unlisted.state} draft={unlisted.draft} merged={unlisted.state === "MERGED"} />
                    <span className={styles.memberNumber}>
                      {repoShortName(group.repo)}
                      {unlisted.number === null ? "" : `#${unlisted.number}`}
                    </span>
                    <span className={styles.memberTitle}>{unlisted.title}</span>
                    <span className={styles.memberTime}>{UNLISTED_LABELS[unlisted.why]}</span>
                  </a>
                </li>
              ) : null,
            )}
          </ol>
        )}
      </div>
    </section>
  );
}
