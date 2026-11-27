import type { RepoConfig } from "./config.ts";
import type { Event, LinkRelation, LinkedSubject, SubjectRef } from "./pipeline/types.ts";
import type { SubjectRecord } from "./types.ts";

type Raw = Record<string, unknown>;

function obj(value: unknown): Raw | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : null;
}

function nodes(value: unknown): Raw[] {
  const list = obj(value)?.nodes;
  return Array.isArray(list) ? list.map(obj).filter((n) => n !== null) : [];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

const STRENGTH: Record<LinkRelation, number> = {
  closes: 3,
  closedBy: 3,
  branchRule: 3,
  duplicate: 2,
  connected: 1,
};

/** Relations that mean one side fixes the other. */
export const CLOSING_RELATIONS: ReadonlySet<LinkRelation> = new Set(["closes", "closedBy", "branchRule"]);

export interface LinksInput {
  subject: SubjectRecord;
  events: readonly Event[];
  config: RepoConfig;
}

function refFromNode(node: Raw, kind: "pr" | "issue", fallbackRepo: string): SubjectRef | null {
  if (typeof node.number !== "number") return null;
  const title = str(node.title);
  const state = str(node.state);
  return {
    kind,
    repo: str(obj(node.repository)?.nameWithOwner) ?? fallbackRepo,
    number: node.number,
    ...(title !== undefined ? { title } : {}),
    ...(state !== undefined ? { state } : {}),
  };
}

/**
 * PRs and issues linked to a subject, from data its own fetch returned: closing references on
 * both sides, closer and cross-reference events, connections, duplicates, and the repo's branch
 * rules applied to a PR's head branch. One entry per PR or issue, keeping the strongest relation;
 * closing links first.
 */
export function linksFor({ subject, events, config }: LinksInput): LinkedSubject[] {
  const byKey = new Map<string, LinkedSubject>();
  const add = (ref: SubjectRef, relation: LinkRelation) => {
    if (ref.repo === subject.repo && ref.number === subject.number) return;
    const key = `${ref.repo}#${ref.number}`;
    const found = byKey.get(key);
    if (!found) {
      byKey.set(key, { kind: ref.kind, repo: ref.repo, number: ref.number, relation, ...pick(ref) });
      return;
    }
    if (STRENGTH[relation] > STRENGTH[found.relation]) found.relation = relation;
    if (found.title === undefined && ref.title !== undefined) found.title = ref.title;
    if (found.state === undefined && ref.state !== undefined) found.state = ref.state;
  };
  const raw = obj(subject.raw);

  if (subject.kind === "pr") {
    for (const n of nodes(raw?.closingIssuesReferences)) {
      const ref = refFromNode(n, "issue", subject.repo);
      if (ref) add(ref, "closes");
    }
    if (subject.headRef) {
      for (const rule of config.branchRules) {
        const number = Number(rule.pattern.exec(subject.headRef)?.[1]);
        if (Number.isInteger(number) && number > 0) add({ kind: "issue", repo: subject.repo, number }, "branchRule");
      }
    }
  } else if (subject.kind === "issue") {
    for (const n of nodes(raw?.closedByPullRequestsReferences)) {
      const ref = refFromNode(n, "pr", subject.repo);
      if (ref) add(ref, "closedBy");
    }
  }

  const connected = new Map<string, SubjectRef>();
  for (const e of events) {
    const ref = e.data.ref;
    if (!ref) continue;
    switch (e.kind) {
      case "closedByPr":
        add(ref, "closedBy");
        break;
      case "crossReference":
        if (e.data.willClose !== true) break;
        if (subject.kind === "issue" && ref.kind === "pr") add(ref, "closedBy");
        else connected.set(`${ref.repo}#${ref.number}`, ref);
        break;
      case "markedDuplicate":
        add(ref, "duplicate");
        break;
      case "connected":
        if (e.data.added === false) connected.delete(`${ref.repo}#${ref.number}`);
        else connected.set(`${ref.repo}#${ref.number}`, ref);
        break;
    }
  }
  for (const ref of connected.values()) add(ref, "connected");

  return [...byKey.values()].sort((a, b) => STRENGTH[b.relation] - STRENGTH[a.relation]);
}

function pick(ref: SubjectRef): Pick<LinkedSubject, "title" | "state"> {
  return {
    ...(ref.title !== undefined ? { title: ref.title } : {}),
    ...(ref.state !== undefined ? { state: ref.state } : {}),
  };
}

/** A link's name relative to the subject's repo: `#5641` or `owner/repo#5641`. */
export function linkName(link: Pick<LinkedSubject, "repo" | "number">, repo: string): string {
  return link.repo === repo ? `#${link.number}` : `${link.repo}#${link.number}`;
}
