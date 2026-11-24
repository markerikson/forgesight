import type { CiState, ReviewDecision, SubjectKind, SubjectState } from "../../core/index.ts";
import { CI_LABELS, REVIEW_LABELS, stateBadge } from "../format.ts";
import styles from "./Badges.module.css";

export function StateIcon(props: { kind: SubjectKind; state: SubjectState | null; draft: boolean; merged: boolean }) {
  const badge = stateBadge(props.kind, props.state, props.draft, props.merged);
  return (
    <span className={`${styles.state} ${styles[`tone-${badge.tone}`]}`} title={badge.label} aria-label={badge.label} role="img">
      {badge.glyph}
    </span>
  );
}

export function CiDot({ state }: { state: CiState | null }) {
  if (!state) return null;
  return <span className={`${styles.ci} ${styles[`ci-${state}`]}`} title={CI_LABELS[state]} aria-label={CI_LABELS[state]} role="img" />;
}

const REVIEW_SHORT: Record<ReviewDecision, string> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes",
  REVIEW_REQUIRED: "review",
};

export function ReviewBadge({ decision }: { decision: ReviewDecision | null }) {
  if (!decision) return null;
  return (
    <span className={`${styles.review} ${styles[`review-${decision}`]}`} title={REVIEW_LABELS[decision]}>
      {REVIEW_SHORT[decision]}
    </span>
  );
}

export function DraftBadge({ draft }: { draft: boolean }) {
  if (!draft) return null;
  return <span className={styles.draft}>draft</span>;
}
