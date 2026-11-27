import { severityWeight } from "../../core/findings/index.ts";
import type { FindingTool } from "../../core/findings/types.ts";
import type { CiState, FindingIcon, ReviewDecision, SubjectKind, SubjectState } from "../../core/index.ts";
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

const TOOL_SHORT: Record<FindingTool, string> = { diffloupe: "DL", coderabbit: "CR" };
const TOOL_NAME: Record<FindingTool, string> = { diffloupe: "DiffLoupe", coderabbit: "CodeRabbit" };

function findingTone(icon: FindingIcon): string {
  const weight = severityWeight(icon.worst);
  if (weight >= 4) return "finding-blocker";
  if (weight >= 3) return "finding-serious";
  return "finding-minor";
}

/** One badge per review tool: outstanding count coloured by the worst one, hollow when only stale ones remain. */
export function FindingBadges({ icons }: { icons: readonly FindingIcon[] }) {
  if (icons.length === 0) return null;
  return (
    <>
      {icons.map((icon) => {
        const onlyStale = icon.outstanding === 0;
        const parts = [`${icon.outstanding} outstanding`, ...(icon.stale > 0 ? [`${icon.stale} stale`] : [])];
        return (
          <span
            key={icon.tool}
            className={`${styles.finding} ${styles[findingTone(icon)]} ${onlyStale ? styles["finding-stale"] : ""}`}
            title={`${TOOL_NAME[icon.tool]}: ${parts.join(", ")} (worst: ${icon.worst})`}
          >
            {TOOL_SHORT[icon.tool]} {onlyStale ? icon.stale : icon.outstanding}
          </span>
        );
      })}
    </>
  );
}
