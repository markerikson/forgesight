import type { SubjectKey } from "../types.ts";
import type { Workstream } from "../workstreams.ts";
import { fnv1a64 } from "./hash.ts";
import { type SchemaName, WORKSTREAM_SUMMARY_SCHEMA } from "./schema.ts";

/** Bump when the prompt or output shape changes; it is part of the input hash. */
export const WORKSTREAM_PROMPT_VERSION = 1;

/** Total description characters across all members, split evenly. Bounds the cost of big stacks. */
export const DESCRIPTION_BUDGET = 24_000;
const MIN_DESCRIPTION = 600;

export type MemberState = "open" | "merged" | "closed";

/** What the prompt knows about one member PR. No diffs, no comments. */
export interface MemberText {
  number: number;
  title: string;
  /** Plain-text description, already truncated at fetch. */
  body: string;
  isDraft: boolean;
  state: MemberState;
}

export interface SummaryRequest {
  promptVersion: number;
  system: string;
  user: string;
  schemaName: SchemaName;
  /** Hash of everything that shapes the prompt. Equal hashes mean an equal request. */
  inputHash: string;
}

export const WORKSTREAM_SYSTEM = `You summarize a workstream: a set of related GitHub pull requests, usually a stack where each PR builds on the one before it.

Write for a maintainer scanning an inbox who wants to know what this work is before opening it.

- name: 2 to 6 words naming the work, not the mechanics ("Fix race in cache invalidation", not "PR stack for cache").
- summary: 2 or 3 plain sentences. Say what the work changes, why, and how far it reaches (which areas, how many steps). Do not list PRs one by one. Do not invent motivation the descriptions do not give.
- status: only when the workstream is closed, or every open PR is a draft and it looks tabled. One short line such as "Merged" or "Closed without merging; superseded by a later approach". Omit it otherwise.

Use plain technical English. No marketing words, no emoji.`;

function flags(text: MemberText): string {
  const out: string[] = [];
  if (text.state !== "open") out.push(text.state);
  if (text.isDraft && text.state === "open") out.push("draft");
  return out.length > 0 ? ` [${out.join(", ")}]` : "";
}

function clip(body: string, max: number): string {
  const trimmed = body.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max).trimEnd()}\n[description truncated]`;
}

/**
 * Builds the prompt for one workstream. Member order follows `ws.members` (stack order).
 * Members missing from `texts` are listed as unavailable; callers normally wait for them.
 * Push-only changes leave the hash alone because nothing here depends on head SHAs or times.
 */
export function buildWorkstreamSummaryRequest(
  ws: Workstream,
  texts: ReadonlyMap<SubjectKey, MemberText>,
): SummaryRequest {
  const perBody = Math.max(MIN_DESCRIPTION, Math.floor(DESCRIPTION_BUDGET / Math.max(1, ws.members.length)));
  const present = ws.members.flatMap((key) => texts.get(key) ?? []);
  const openPulls = present.filter((t) => t.state === "open");
  const tabled = openPulls.length > 0 && openPulls.every((t) => t.isDraft);
  const state = ws.closed ? "closed" : tabled ? "open, every open PR is a draft" : "open";

  const sections = ws.members.map((key) => {
    const text = texts.get(key);
    if (!text) return `## ${key}\n(description not available)`;
    const body = clip(text.body, perBody);
    return `## #${text.number} ${text.title.trim()}${flags(text)}\n${body || "(no description)"}`;
  });

  const user = [
    `Repository: ${ws.repo}`,
    `Workstream state: ${state}`,
    `Pull requests, base of the stack first:`,
    "",
    sections.join("\n\n"),
  ].join("\n");

  const inputHash = fnv1a64(
    JSON.stringify([WORKSTREAM_PROMPT_VERSION, WORKSTREAM_SUMMARY_SCHEMA, WORKSTREAM_SYSTEM, user]),
  );
  return {
    promptVersion: WORKSTREAM_PROMPT_VERSION,
    system: WORKSTREAM_SYSTEM,
    user,
    schemaName: WORKSTREAM_SUMMARY_SCHEMA,
    inputHash,
  };
}
