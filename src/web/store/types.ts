import type { Section } from "../../core/index.ts";

export const SECTIONS: readonly Section[] = ["waiting", "updates", "snoozed", "hidden"];

export const SECTION_LABELS: Record<Section, string> = {
  waiting: "Waiting",
  updates: "Updates",
  snoozed: "Snoozed",
  hidden: "Hidden",
};
