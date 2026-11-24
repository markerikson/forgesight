import type { InboxRow, Section, SubjectView } from "../../core/index.ts";

export interface SectionCounts {
  waiting: number;
  updates: number;
  snoozed: number;
  hidden: number;
}

export interface RepoCounts {
  repo: string;
  waiting: number;
  updates: number;
}

export interface InboxPayload {
  /** Sorted by section order, then `sortAt` newest first. */
  rows: InboxRow[];
  sidebar: { sections: SectionCounts; repos: RepoCounts[] };
  /** Per-repo summaries of hidden activity, e.g. "backend: 38 pushed, 12 merged". */
  countLines: string[];
  generatedAt: string;
}

export interface SubjectDetail extends SubjectView {
  /** Notification reason of the newest thread, e.g. "review_requested". */
  reason: string | null;
  /** GitHub page for the subject, or the notification's URL when there is no PR or issue. */
  githubUrl: string | null;
}

export const SECTIONS: readonly Section[] = ["waiting", "updates", "snoozed", "hidden"];

export const SECTION_LABELS: Record<Section, string> = {
  waiting: "Waiting",
  updates: "Updates",
  snoozed: "Snoozed",
  hidden: "Hidden",
};
