import { useState } from "react";
import {
  type GroupSummary,
  groupTotals,
  type InboxGroup,
  isNewWorkstream,
  type SubjectWorkstream,
} from "../../core/inbox.ts";
import type { SubjectKey } from "../../core/types.ts";
import type { WsPriority as WorkstreamPriority } from "../../core/workstream-state.ts";
import { relativeTime, repoShortName } from "../format.ts";
import { useNow } from "../hooks/useNow.ts";
import {
  doneAllWorkstream,
  doneKeys,
  mergeWorkstreamInto,
  openWorkstreamSnooze,
  removeFromWorkstream,
  renameWorkstream,
  setWorkstreamPriority,
} from "../store/actions.ts";
import { useGetSubjectQuery } from "../store/api.ts";
import { useAppDispatch, useAppSelector } from "../store/hooks.ts";
import { selectGoneKeys, selectSubject } from "../store/view.ts";
import { anchorBelow } from "./SnoozeMenu.tsx";
import { CiDot, ReviewBadge, StateIcon } from "./Badges.tsx";
import { Description } from "./Description.tsx";
import { GitHubIcon, SubjectLink } from "./SubjectLink.tsx";
import { UNLISTED_LABELS } from "./GroupRow.tsx";
import { WorkstreamPicker } from "./WorkstreamPicker.tsx";
import previewStyles from "./Preview.module.css";
import styles from "./WorkstreamPreview.module.css";

const PRIORITIES: { value: WorkstreamPriority; label: string; title: string }[] = [
  { value: "normal", label: "Normal", title: "Show in Waiting or Updates like its members" },
  { value: "low", label: "Low", title: "Stay collapsed in Updates; new PRs do not raise it" },
  { value: "muted", label: "Muted", title: "Move to Hidden; review requests and mentions still show" },
];

function keyLabel(key: SubjectKey): string {
  const hash = key.indexOf("#");
  return hash === -1 ? key : `#${key.slice(hash + 1)}`;
}

function SummaryBlock({ summary }: { summary: GroupSummary }) {
  const now = useNow();
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
  const label = title ? `${keyLabel(subjectKey)} ${title}` : keyLabel(subjectKey);
  return (
    <SubjectLink subjectKey={subjectKey} className={styles.link} title={title ?? subjectKey}>
      {label}
    </SubjectLink>
  );
}

function totalsText(group: InboxGroup, now: number | null): string {
  const totals = groupTotals(group);
  const counts = [
    totals.open > 0 && `${totals.open} open`,
    totals.draft > 0 && `${totals.draft} draft`,
    totals.merged > 0 && `${totals.merged} merged`,
    totals.closed > 0 && `${totals.closed} closed`,
  ].filter((part) => part !== false);
  const activity =
    now !== null && totals.lastActivityAt !== null ? `last activity ${relativeTime(totals.lastActivityAt, now)} ago` : null;
  return [counts.join(", "), activity].filter(Boolean).join(" · ");
}

/** The first member's description: from the payload when it has no inbox row, else its subject. */
function RootDescription({ group }: { group: InboxGroup }) {
  const rootKey = group.memberKeys[0];
  const { data } = useGetSubjectQuery(rootKey ?? "", { skip: rootKey === undefined || group.rootBody !== null });
  if (rootKey === undefined) return null;
  const label = `Description of ${keyLabel(rootKey)}`;
  if (group.rootBody !== null) {
    const note = group.rootBody.clipped ? "Cut short; the full description is on GitHub." : undefined;
    return <Description key={rootKey} body={group.rootBody.text} label={label} plain note={note} />;
  }
  const body = data && data.key === rootKey ? data.body : null;
  if (!body) return null;
  return <Description key={rootKey} body={body} label={label} />;
}

/** Where the open subject sits in its stack, and what the workstream is about. */
export function StackBox({ workstream }: { workstream: SubjectWorkstream }) {
  const { stack, titles } = workstream;
  return (
    <section className={styles.stack} aria-label="Stack">
      <div className={styles.stackHead}>
        <span className={styles.stackName}>{workstream.name}</span>
        <span className={styles.position}>
          {stack.position} of {stack.size}
          {workstream.stacked && " in stack"}
        </span>
      </div>
      {workstream.stacked && (
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
      )}
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

function RemoveButton({ group, subjectKey }: { group: InboxGroup; subjectKey: SubjectKey }) {
  const dispatch = useAppDispatch();
  return (
    <button
      type="button"
      className={styles.memberRemove}
      title={`Remove ${keyLabel(subjectKey)} from ${group.name}`}
      onClick={() => dispatch(removeFromWorkstream(group, subjectKey))}
    >
      Remove
    </button>
  );
}

/** Preview of a selected workstream row: summary, state controls and the whole stack. */
export function WorkstreamPane({ group }: { group: InboxGroup }) {
  const dispatch = useAppDispatch();
  const now = useNow();
  const stack = stackOrder(group);
  const gone = useAppSelector(selectGoneKeys);
  const doneCount = doneKeys([group], gone).length;
  const totals = totalsText(group, now);
  const [mergeAnchor, setMergeAnchor] = useState<{ top: number; left: number } | null>(null);
  // Removing the last member would leave nothing to split off.
  const removable = group.memberKeys.length > 1;
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
          <button
            type="button"
            title="Merge this workstream into another"
            onClick={(e) => setMergeAnchor(anchorBelow(e.currentTarget))}
          >
            Merge into…
          </button>
        </div>
        {mergeAnchor && (
          <WorkstreamPicker
            repo={group.repo}
            title={`Merge “${group.name}” into…`}
            excludeId={group.id}
            anchor={mergeAnchor}
            onChoose={(id) => dispatch(mergeWorkstreamInto(group, id))}
            onClose={() => setMergeAnchor(null)}
          />
        )}
        <header className={previewStyles.header}>
          <h2 className={previewStyles.title}>{group.name}</h2>
          <div className={previewStyles.meta}>
            <span>{group.repo}</span>
            <span>
              {group.members.length + group.moreCount} pull requests and issues
              {group.moreCount > 0 && ` (${group.moreCount} not listed)`}
            </span>
            {isNewWorkstream(group) && <span className={styles.newBadge}>new workstream</span>}
            {group.closed && <span>closed</span>}
            {group.snoozeUntil && <span>snoozed until {group.snoozeUntil.slice(0, 10)}</span>}
            {group.closedByAuthor > 0 && <span>{group.closedByAuthor} closed by author</span>}
          </div>
          {totals && <div className={previewStyles.meta}>{totals}</div>}
        </header>
      </div>
      <div className={styles.body}>
        {group.summary && <SummaryBlock summary={group.summary} />}
        {stack.length > 0 && (
          <ol className={styles.members}>
            {stack.map(({ key, member, unlisted }) =>
              member ? (
                <li key={key} className={styles.member}>
                  <StateIcon kind={member.kind} state={member.state} draft={member.draft} merged={member.merged} />
                  <button type="button" className={styles.memberMain} onClick={() => dispatch(selectSubject(member.key))}>
                    <span className={styles.memberNumber}>
                      {repoShortName(member.repo)}#{member.number}
                    </span>
                    <span className={styles.memberTitle}>{member.title}</span>
                  </button>
                  {member.url && <GitHubIcon url={member.url} />}
                  <CiDot state={member.ciState} />
                  <ReviewBadge decision={member.reviewDecision} />
                  {member.newMeaningfulCount > 0 && (
                    <span className={styles.memberNew}>{member.newMeaningfulCount} new</span>
                  )}
                  {member.author && <span className={styles.memberAuthor}>{member.author}</span>}
                  {now !== null && <span className={styles.memberTime}>{relativeTime(member.sortAt, now)}</span>}
                  {removable && <RemoveButton group={group} subjectKey={key} />}
                </li>
              ) : unlisted ? (
                <li key={key} className={styles.member}>
                  <StateIcon kind="pr" state={unlisted.state} draft={unlisted.draft} merged={unlisted.state === "MERGED"} />
                  <SubjectLink subjectKey={key} url={unlisted.url} className={styles.memberTitle} title={unlisted.title}>
                    <span className={styles.memberNumber}>
                      {repoShortName(group.repo)}
                      {unlisted.number === null ? "" : `#${unlisted.number}`}
                    </span>{" "}
                    {unlisted.title}
                  </SubjectLink>
                  <span className={styles.memberWhy}>{UNLISTED_LABELS[unlisted.why]}</span>
                  {unlisted.author && <span className={styles.memberAuthor}>{unlisted.author}</span>}
                  {now !== null && unlisted.updatedAt && (
                    <span className={styles.memberTime}>{relativeTime(unlisted.updatedAt, now)}</span>
                  )}
                  {removable && <RemoveButton group={group} subjectKey={key} />}
                </li>
              ) : null,
            )}
          </ol>
        )}
        <RootDescription group={group} />
      </div>
    </section>
  );
}
