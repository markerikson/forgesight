import type { SubjectKey } from "./types.ts";

/** One PR from the open-PR listing, or from the recently-closed list when `closed` is set. */
export interface WsPull {
  repo: string;
  number: number;
  title: string;
  author: string;
  /** GitHub actor type from the listing ("User", "Bot"). Bots never group by title prefix. */
  authorType?: string;
  headRef: string;
  baseRef: string;
  isDraft: boolean;
  updatedAt: string;
  closed?: "merged" | "closed";
  /** When the PR was merged or closed; falls back to `updatedAt`. */
  closedAt?: string;
}

export type WsSignal = "stack" | "sharedBase" | "config" | "titlePrefix" | "manual";

export interface WsEdge {
  child: SubjectKey;
  parent: SubjectKey;
}

export interface Workstream {
  /** Stable across rebuilds; see `buildWorkstreams`. */
  id: string;
  repo: string;
  name: string;
  nameSource: "manual" | "config" | "prefix" | "title";
  /** Subject keys in stack order (depth first from each root, roots by number). */
  members: SubjectKey[];
  /** Branch stack edges inside the group. */
  edges: WsEdge[];
  signals: WsSignal[];
  /** The most common member author. Used with `prefix` to carry an ID over to a reopened stack. */
  author: string;
  /** Normalized title prefix shared by most members, if any. */
  prefix: string | null;
  /** Every member is merged or closed. */
  closed: boolean;
  /** Latest member close time when `closed`, else null. */
  closedAt: string | null;
}

/**
 * Manual corrections, applied after detection in the order given, so they survive rebuilds.
 * `merge` joins the workstreams holding the two subjects (a subject with no workstream joins
 * as a new member). `remove` takes a subject out of its workstream. `rename` names a workstream.
 */
export type WsOverride =
  | { kind: "merge"; keys: [SubjectKey, SubjectKey] }
  | { kind: "remove"; key: SubjectKey }
  | { kind: "rename"; id: string; name: string };

export interface WorkstreamGroupRule {
  name: string;
  /** A PR matches when its title matches any of `titles` or its head branch any of `branches`. */
  titles: RegExp[];
  branches: RegExp[];
  /** When non-empty, only PRs by these logins match. */
  authors: string[];
}

export interface WorkstreamConfig {
  /** A PR with two or more child subtrees of at least this many PRs splits them off. */
  forkMinSize: number;
  /** Titles that end the group above them; their children start new groups. */
  cutBelow: RegExp[];
  /** Extra title prefixes that never group, lowercase. */
  genericPrefixes: string[];
  /** Logins that never group by title prefix, in addition to `[bot]` logins and Bot actors. */
  botAuthors: string[];
  groups: WorkstreamGroupRule[];
}

export interface BuildWorkstreamsOptions {
  /** Base branches that are not stacks. */
  trunks: string[];
  overrides: WsOverride[];
  /** The last build's workstreams, including closed ones, for stable IDs. */
  previous: Workstream[];
  config: WorkstreamConfig;
  now: Date;
}

export interface StackContext {
  workstreamId: string;
  parent: SubjectKey | null;
  children: SubjectKey[];
  /** 1-based position in `members`. */
  position: number;
  size: number;
}

const REOPEN_WINDOW_MS = 14 * 86_400_000;

const GENERIC_PREFIXES = new Set([
  "fix", "fixes", "feat", "feature", "chore", "wip", "refactor", "test", "tests", "docs", "doc",
  "build", "ci", "perf", "style", "revert", "tmp", "draft", "codex", "claude", "base", "join",
]);

export function subjectKeyOf(pull: Pick<WsPull, "repo" | "number">): SubjectKey {
  return `${pull.repo}#${pull.number}`;
}

function isCamelOrDashed(word: string): boolean {
  return /^[A-Za-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+$/.test(word) || /^[a-z0-9]+(?:-[a-z0-9]+)+$/i.test(word);
}

function isGenericPrefix(key: string, extra: readonly string[]): boolean {
  if (key.length < 2 || GENERIC_PREFIXES.has(key) || extra.includes(key)) return true;
  if (/^#?\d+$/.test(key) || /^[a-z]+-\d+$/.test(key)) return true;
  const type = /^([a-z]+)\([^)]*\)!?$/.exec(key)?.[1];
  return type !== undefined && GENERIC_PREFIXES.has(type);
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`workstreams: missing ${what}`);
  return value;
}

export interface TitlePrefix {
  /** Lowercase, whitespace collapsed. */
  key: string;
  display: string;
}

/**
 * Leading prefixes of a title: text inside leading brackets or parentheses, then text before
 * `:`, or else the first word when it is a CamelCase or dashed identifier. Generic words,
 * ticket numbers, and bracket text matching a `cutBelow` pattern are dropped.
 */
export function titlePrefixes(
  title: string,
  config: Pick<WorkstreamConfig, "cutBelow" | "genericPrefixes">,
): TitlePrefix[] {
  const found: string[] = [];
  let rest = title.trim().replace(/^[^\p{L}\p{N}[(]+/u, "");
  const lead = /^[[(]([^\])]+)[\])]\s*/.exec(rest);
  if (lead) {
    const [whole, inner = ""] = lead;
    if (!config.cutBelow.some((re) => re.test(whole.trim()))) found.push(inner.trim());
    rest = rest.slice(whole.length);
  }
  const colon = /^([^:]{2,40}):\s/.exec(rest)?.[1];
  if (colon !== undefined) found.push(colon.trim());
  else {
    const first = rest.split(/\s+/)[0] ?? "";
    if (isCamelOrDashed(first)) found.push(first);
  }
  const generic = config.genericPrefixes.map((p) => p.toLowerCase());
  const out: TitlePrefix[] = [];
  for (const display of found) {
    const key = display.toLowerCase().replace(/\s+/g, " ");
    if (!isGenericPrefix(key, generic) && !out.some((p) => p.key === key)) out.push({ key, display });
  }
  return out;
}

function isBot(pull: WsPull, config: WorkstreamConfig): boolean {
  if (pull.authorType === "Bot" || pull.author.endsWith("[bot]")) return true;
  const login = pull.author.toLowerCase();
  return config.botAuthors.some((b) => b.toLowerCase() === login);
}

function matchesGroupRule(pull: WsPull, rule: WorkstreamGroupRule): boolean {
  const login = pull.author.toLowerCase();
  if (rule.authors.length > 0 && !rule.authors.some((a) => a.toLowerCase() === login)) return false;
  return rule.titles.some((re) => re.test(pull.title)) || rule.branches.some((re) => re.test(pull.headRef));
}

class UnionFind {
  private parent = new Map<SubjectKey, SubjectKey>();
  find(x: SubjectKey): SubjectKey {
    let root = x;
    for (let p = this.parent.get(root); p !== undefined && p !== root; p = this.parent.get(root)) root = p;
    for (let cur = x; cur !== root; ) {
      const next = this.parent.get(cur);
      if (next === undefined) break;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  /** Returns the new root. */
  union(a: SubjectKey, b: SubjectKey): SubjectKey {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
    return ra;
  }
}

interface Join {
  a: SubjectKey;
  b: SubjectKey;
  signal: WsSignal;
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function mostCommon<T>(values: readonly T[]): { value: T; count: number } | null {
  const counts = new Map<T, number>();
  let best: { value: T; count: number } | null = null;
  for (const v of values) {
    const c = (counts.get(v) ?? 0) + 1;
    counts.set(v, c);
    if (!best || c > best.count) best = { value: v, count: c };
  }
  return best;
}

/**
 * Groups PRs into workstreams. Signals, joined in this order:
 *
 * 1. Stack edge: a PR whose base is another PR's head branch. When two open PRs share the head
 *    branch there is no edge. Edges are cut below `cutBelow` titles and where a PR has two or
 *    more child subtrees of at least `forkMinSize` PRs (each such subtree becomes its own group).
 * 2. Shared base: two or more PRs on the same non-trunk base branch that no PR has as head.
 * 3. Config groups: PRs matching a configured rule, and their groups, join under its name.
 * 4. Title prefix (weak): same author and prefix. It attaches PRs with no other signal to a
 *    group or to each other, never joins two groups from steps 1-3, and a prefix found in two
 *    or more such groups by the same author is generic for that author. Bots are excluded.
 * 5. Manual overrides.
 *
 * IDs: a group takes the ID of the previous group it shares the most members with (at least
 * half of the smaller). Otherwise a group with open members takes the ID of a previous group
 * with its author and prefix that closed within 14 days; when that previous group is still
 * present and fully closed, the two merge. Otherwise the ID is `<repo>:ws:<lowest number>`.
 * A single PR with no signal is not a workstream.
 */
export function buildWorkstreams(pulls: readonly WsPull[], opts: BuildWorkstreamsOptions): Workstream[] {
  const { config, trunks } = opts;
  const byKey = new Map<SubjectKey, WsPull>();
  for (const p of pulls) {
    const key = subjectKeyOf(p);
    const seen = byKey.get(key);
    if (!seen || (seen.closed && !p.closed)) byKey.set(key, p);
  }
  const pullOf = (key: SubjectKey) => must(byKey.get(key), key);
  const all = [...byKey.values()].sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number);
  const branch = (repo: string, ref: string) => `${repo}\0${ref}`;
  const byHead = new Map<string, WsPull[]>();
  for (const p of all) pushTo(byHead, branch(p.repo, p.headRef), p);

  // Stack parents. Open PRs win over closed ones on a reused branch; two open PRs on one
  // branch (forks) give no edge.
  const parentOf = new Map<SubjectKey, WsPull>();
  for (const p of all) {
    if (trunks.includes(p.baseRef)) continue;
    const candidates = (byHead.get(branch(p.repo, p.baseRef)) ?? []).filter((c) => c !== p);
    const open = candidates.filter((c) => !c.closed);
    const parent = open.length > 0 ? (open.length === 1 ? open[0] : undefined) : candidates.at(-1);
    if (parent) parentOf.set(subjectKeyOf(p), parent);
  }
  for (const key of [...parentOf.keys()]) {
    const seen = new Set([key]);
    for (let up = parentOf.get(key); up; up = parentOf.get(subjectKeyOf(up))) {
      const upKey = subjectKeyOf(up);
      if (seen.has(upKey)) {
        parentOf.delete(key);
        break;
      }
      seen.add(upKey);
    }
  }
  const childrenOf = new Map<SubjectKey, WsPull[]>();
  for (const [childKey, parent] of parentOf) pushTo(childrenOf, subjectKeyOf(parent), pullOf(childKey));

  const subtree = new Map<SubjectKey, number>();
  const sizeOf = (key: SubjectKey): number => {
    const known = subtree.get(key);
    if (known !== undefined) return known;
    let size = 1;
    for (const c of childrenOf.get(key) ?? []) size += sizeOf(subjectKeyOf(c));
    subtree.set(key, size);
    return size;
  };
  const isCutParent = (p: WsPull) => config.cutBelow.some((re) => re.test(p.title));
  const isCutEdge = (childKey: SubjectKey, parent: WsPull) => {
    if (isCutParent(parent)) return true;
    const big = (childrenOf.get(subjectKeyOf(parent)) ?? [])
      .map(subjectKeyOf)
      .filter((k) => sizeOf(k) >= config.forkMinSize);
    return big.length >= 2 && big.includes(childKey);
  };

  const uf = new UnionFind();
  const joins: Join[] = [];
  const edges: WsEdge[] = [];
  const join = (a: SubjectKey, b: SubjectKey, signal: WsSignal) => {
    joins.push({ a, b, signal });
    return uf.union(a, b);
  };

  for (const [childKey, parent] of parentOf) {
    if (isCutEdge(childKey, parent)) continue;
    const parentKey = subjectKeyOf(parent);
    edges.push({ child: childKey, parent: parentKey });
    join(parentKey, childKey, "stack");
  }

  const byBase = new Map<string, WsPull[]>();
  for (const p of all) {
    if (trunks.includes(p.baseRef) || byHead.has(branch(p.repo, p.baseRef))) continue;
    pushTo(byBase, branch(p.repo, p.baseRef), p);
  }
  const joinAll = (keys: readonly SubjectKey[], signal: WsSignal) => {
    const [first, ...rest] = keys;
    if (first !== undefined) for (const k of rest) join(first, k, signal);
  };
  for (const group of byBase.values()) joinAll(group.map(subjectKeyOf), "sharedBase");

  const configMatches = config.groups.map((rule) => {
    const matches = all.filter((p) => matchesGroupRule(p, rule)).map(subjectKeyOf);
    joinAll(matches, "config");
    return { name: rule.name, matches };
  });

  // Groups from structural signals; title prefixes never join two of these.
  const structural = new Set<SubjectKey>();
  {
    const sizes = new Map<SubjectKey, number>();
    for (const p of all) {
      const r = uf.find(subjectKeyOf(p));
      sizes.set(r, (sizes.get(r) ?? 0) + 1);
    }
    for (const [r, n] of sizes) if (n > 1) structural.add(r);
  }

  const prefixesByKey = new Map<SubjectKey, TitlePrefix[]>();
  for (const p of all) prefixesByKey.set(subjectKeyOf(p), titlePrefixes(p.title, config));

  const byAuthorPrefix = new Map<string, WsPull[]>();
  const groupsByAuthorPrefix = new Map<string, Set<SubjectKey>>();
  for (const p of all) {
    if (isBot(p, config)) continue;
    const key = subjectKeyOf(p);
    const root = uf.find(key);
    for (const prefix of prefixesByKey.get(key) ?? []) {
      const ap = `${p.author}\0${prefix.key}`;
      pushTo(byAuthorPrefix, ap, p);
      if (structural.has(root)) {
        const roots = groupsByAuthorPrefix.get(ap) ?? new Set();
        roots.add(root);
        groupsByAuthorPrefix.set(ap, roots);
      }
    }
  }
  const prefixGroups = [...byAuthorPrefix].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  for (const [ap, [first, ...rest]] of prefixGroups) {
    if (first === undefined || (groupsByAuthorPrefix.get(ap)?.size ?? 0) >= 2) continue;
    const a = subjectKeyOf(first);
    for (const p of rest) {
      const b = subjectKeyOf(p);
      const ra = uf.find(a);
      const rb = uf.find(b);
      if (ra === rb || (structural.has(ra) && structural.has(rb))) continue;
      const wasStructural = structural.has(ra) || structural.has(rb);
      structural.delete(ra);
      structural.delete(rb);
      const root = join(a, b, "titlePrefix");
      if (wasStructural) structural.add(root);
    }
  }

  // Detected groups as member sets, then manual merge/remove.
  const memberSets = new Map<SubjectKey, Set<SubjectKey>>();
  for (const p of all) {
    const key = subjectKeyOf(p);
    const root = uf.find(key);
    const set = memberSets.get(root) ?? new Set();
    set.add(key);
    memberSets.set(root, set);
  }
  const groupOf = new Map<SubjectKey, Set<SubjectKey>>();
  for (const set of memberSets.values()) for (const k of set) groupOf.set(k, set);
  const manual = new Set<Set<SubjectKey>>();

  for (const o of opts.overrides) {
    if (o.kind === "merge") {
      const [a, b] = o.keys;
      const ga = groupOf.get(a);
      const gb = groupOf.get(b);
      if (!ga || !gb) continue;
      if (ga !== gb) {
        for (const k of gb) {
          ga.add(k);
          groupOf.set(k, ga);
        }
        manual.delete(gb);
      }
      manual.add(ga);
    } else if (o.kind === "remove") {
      const g = groupOf.get(o.key);
      if (!g || g.size < 2) continue;
      g.delete(o.key);
      const alone = new Set([o.key]);
      groupOf.set(o.key, alone);
      manual.add(g);
    }
  }

  const finalSets = [...new Set(groupOf.values())].filter((s) => s.size > 1);
  const describe = (set: Set<SubjectKey>, extraSignals: readonly WsSignal[] = []) =>
    describeGroup(set, {
      byKey,
      edges,
      joins,
      prefixesByKey,
      configName: configMatches.find((c) => c.matches.some((k) => set.has(k)))?.name ?? null,
      manual: manual.has(set),
      extraSignals,
      cutBelow: config.cutBelow,
    });
  const drafts = finalSets.map((set) => ({ set, extra: [] as WsSignal[], ws: describe(set) }));

  // Stable IDs: member overlap first.
  const previous = opts.previous;
  const pairs: { d: number; id: string; overlap: number }[] = [];
  drafts.forEach((draft, d) => {
    for (const prev of previous) {
      if (prev.repo !== draft.ws.repo) continue;
      const overlap = prev.members.filter((k) => draft.set.has(k)).length;
      if (overlap > 0 && overlap * 2 >= Math.min(prev.members.length, draft.set.size)) {
        pairs.push({ d, id: prev.id, overlap });
      }
    }
  });
  pairs.sort((x, y) => y.overlap - x.overlap || x.id.localeCompare(y.id));
  const idOf = new Map<number, string>();
  const ownerOf = new Map<string, number>();
  for (const { d, id } of pairs) {
    if (idOf.has(d) || ownerOf.has(id)) continue;
    idOf.set(d, id);
    ownerOf.set(id, d);
  }

  // Then a reopened stack: same author and prefix as a recently closed previous group.
  const merged = new Set<number>();
  const now = opts.now.getTime();
  drafts.forEach((draft, d) => {
    if (idOf.has(d) || draft.ws.closed || draft.ws.prefix === null) return;
    const candidates = previous
      .flatMap((prev) =>
        prev.closed &&
        prev.closedAt !== null &&
        now - Date.parse(prev.closedAt) <= REOPEN_WINDOW_MS &&
        prev.repo === draft.ws.repo &&
        prev.author === draft.ws.author &&
        prev.prefix === draft.ws.prefix
          ? [{ id: prev.id, closedAt: prev.closedAt }]
          : [],
      )
      .sort((a, b) => b.closedAt.localeCompare(a.closedAt));
    for (const prev of candidates) {
      const owner = ownerOf.get(prev.id);
      if (owner === undefined) {
        idOf.set(d, prev.id);
        ownerOf.set(prev.id, d);
        return;
      }
      const target = drafts[owner];
      if (!target || merged.has(owner) || !target.ws.closed) continue;
      for (const k of draft.set) target.set.add(k);
      target.extra.push("titlePrefix");
      merged.add(d);
      return;
    }
  });

  const result: Workstream[] = [];
  const taken = new Set(ownerOf.keys());
  drafts.forEach((draft, d) => {
    if (merged.has(d)) return;
    const ws = draft.extra.length > 0 ? describe(draft.set, draft.extra) : draft.ws;
    let id = idOf.get(d);
    if (id === undefined) {
      const numbers = ws.members.map((k) => pullOf(k).number).sort((a, b) => a - b);
      id = numbers.map((n) => `${ws.repo}:ws:${n}`).find((candidate) => !taken.has(candidate));
      id ??= `${ws.repo}:ws:${numbers[0]}-${d}`;
      taken.add(id);
    }
    result.push({ ...ws, id });
  });

  for (const o of opts.overrides) {
    if (o.kind !== "rename") continue;
    const ws = result.find((w) => w.id === o.id);
    if (!ws) continue;
    ws.name = o.name;
    ws.nameSource = "manual";
    if (!ws.signals.includes("manual")) ws.signals.push("manual");
  }

  const lowest = (ws: Workstream) => Math.min(...ws.members.map((k) => pullOf(k).number));
  return result.sort((a, b) => a.repo.localeCompare(b.repo) || lowest(a) - lowest(b));
}

const SIGNAL_ORDER: WsSignal[] = ["stack", "sharedBase", "config", "titlePrefix", "manual"];

function describeGroup(
  set: Set<SubjectKey>,
  ctx: {
    byKey: Map<SubjectKey, WsPull>;
    edges: readonly WsEdge[];
    joins: readonly Join[];
    prefixesByKey: Map<SubjectKey, TitlePrefix[]>;
    configName: string | null;
    manual: boolean;
    extraSignals: readonly WsSignal[];
    cutBelow: readonly RegExp[];
  },
): Omit<Workstream, "id"> {
  const pullOf = (k: SubjectKey) => must(ctx.byKey.get(k), k);
  const pulls = [...set].map(pullOf).sort((a, b) => a.number - b.number);
  const first = must(pulls[0], "group member");
  const edges = ctx.edges.filter((e) => set.has(e.child) && set.has(e.parent));
  const childrenOf = new Map<SubjectKey, SubjectKey[]>();
  const hasParent = new Set<SubjectKey>();
  for (const e of edges) {
    pushTo(childrenOf, e.parent, e.child);
    hasParent.add(e.child);
  }
  const number = (k: SubjectKey) => pullOf(k).number;
  const members: SubjectKey[] = [];
  const visit = (k: SubjectKey) => {
    members.push(k);
    for (const c of (childrenOf.get(k) ?? []).sort((a, b) => number(a) - number(b))) visit(c);
  };
  for (const p of pulls) {
    const k = subjectKeyOf(p);
    if (!hasParent.has(k)) visit(k);
  }
  edges.sort((a, b) => members.indexOf(a.child) - members.indexOf(b.child));

  const signals = new Set<WsSignal>(ctx.extraSignals);
  for (const j of ctx.joins) if (set.has(j.a) && set.has(j.b)) signals.add(j.signal);
  if (ctx.manual) signals.add("manual");

  const author = mostCommon(pulls.map((p) => p.author))?.value ?? first.author;
  const prefixes = members.flatMap((k) => ctx.prefixesByKey.get(k) ?? []);
  const topPrefix = mostCommon(prefixes.map((p) => p.key));
  const prefix = topPrefix && topPrefix.count >= 2 ? topPrefix.value : null;
  const ordered = members.map(pullOf);
  const root = ordered.find((p) => !ctx.cutBelow.some((re) => re.test(p.title))) ?? ordered[0] ?? first;

  let name: string;
  let nameSource: Workstream["nameSource"];
  if (ctx.configName !== null) {
    name = ctx.configName;
    nameSource = "config";
  } else if (prefix !== null) {
    name = mostCommon(prefixes.filter((p) => p.key === prefix).map((p) => p.display))?.value ?? prefix;
    nameSource = "prefix";
  } else {
    name = root.title;
    nameSource = "title";
  }

  const closed = pulls.every((p) => p.closed !== undefined);
  const closedAt = closed
    ? pulls.map((p) => p.closedAt ?? p.updatedAt).reduce((a, b) => (a > b ? a : b))
    : null;

  return {
    repo: first.repo,
    name,
    nameSource,
    members,
    edges,
    signals: SIGNAL_ORDER.filter((s) => signals.has(s)),
    author,
    prefix,
    closed,
    closedAt,
  };
}

/** Where one subject sits in its workstream, for the preview's stack box. */
export function stackContext(ws: Workstream, key: SubjectKey): StackContext | null {
  const index = ws.members.indexOf(key);
  if (index < 0) return null;
  return {
    workstreamId: ws.id,
    parent: ws.edges.find((e) => e.child === key)?.parent ?? null,
    children: ws.edges.filter((e) => e.parent === key).map((e) => e.child),
    position: index + 1,
    size: ws.members.length,
  };
}
