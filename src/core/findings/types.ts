export type FindingTool = "diffloupe" | "coderabbit";

export type FindingStatus = "outstanding" | "stale" | "fixed" | "resolved";

export type FindingSeverity =
  | "blocker"
  | "should-fix"
  | "nice-to-have"
  | "question"
  | "critical"
  | "major"
  | "minor"
  | "trivial"
  | "unknown";

/** One finding as a bot reported it. */
export interface FindingReport {
  tool: FindingTool;
  /** DiffLoupe fingerprint, or the CodeRabbit review thread node id. */
  id: string;
  severity: FindingSeverity;
  /** The severity as the bot printed it ("Should fix", "Major"). */
  label: string;
  category: string | null;
  file: string | null;
  line: number | null;
  title: string;
  /** Markdown an agent can act on: DiffLoupe's copy section, CodeRabbit's agent prompt. */
  copyText: string | null;
  url: string | null;
}

export interface Finding extends FindingReport {
  status: FindingStatus;
  firstSeenAt: string;
  /** First reported after the subject was last dismissed. */
  isNew: boolean;
  serious: boolean;
  /** Why the status is what it is, when that is not obvious ("reviews stopped at abc1234"). */
  note: string | null;
}

export interface FindingIcon {
  tool: FindingTool;
  outstanding: number;
  stale: number;
  /** Worst severity among outstanding findings, or among stale ones when none are outstanding. */
  worst: FindingSeverity;
}
