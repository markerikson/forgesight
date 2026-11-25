import type { Database } from "bun:sqlite";

export type PrState = "OPEN" | "CLOSED" | "MERGED";

/** A PR's title and description, as fetched for workstream summaries. */
export interface PrText {
  repo: string;
  number: number;
  title: string;
  /** `bodyText`, truncated by the fetcher. */
  body: string;
  /** The PR's `updatedAt` when fetched. */
  updatedAt: string;
  fetchedAt: string;
  /** State when fetched; `null` for rows stored before the column existed. */
  state: PrState | null;
  isDraft: boolean;
}

interface PrTextRow {
  repo: string;
  number: number;
  title: string;
  body: string;
  updated_at: string;
  fetched_at: string;
  state: PrState | null;
  is_draft: number;
}

const fromRow = (r: PrTextRow): PrText => ({
  repo: r.repo,
  number: r.number,
  title: r.title,
  body: r.body,
  updatedAt: r.updated_at,
  fetchedAt: r.fetched_at,
  state: r.state,
  isDraft: r.is_draft === 1,
});

export function getPrText(db: Database, repo: string, number: number): PrText | undefined {
  const row = db
    .query<PrTextRow, [string, number]>("SELECT * FROM pr_texts WHERE repo = ? AND number = ?")
    .get(repo, number);
  return row ? fromRow(row) : undefined;
}

/** Stored texts for `numbers` in `repo`, keyed by number. */
export function getPrTexts(db: Database, repo: string, numbers: number[]): Map<number, PrText> {
  const rows = db
    .query<PrTextRow, [string, string]>(
      "SELECT * FROM pr_texts WHERE repo = ? AND number IN (SELECT value FROM json_each(?))",
    )
    .all(repo, JSON.stringify(numbers));
  return new Map(rows.map((r) => [r.number, fromRow(r)]));
}

export function putPrTexts(db: Database, texts: PrText[]): void {
  const upsert = db.query(
    `INSERT INTO pr_texts (repo, number, title, body, updated_at, fetched_at, state, is_draft)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (repo, number) DO UPDATE SET
       title = excluded.title, body = excluded.body,
       updated_at = excluded.updated_at, fetched_at = excluded.fetched_at,
       state = excluded.state, is_draft = excluded.is_draft`,
  );
  db.transaction(() => {
    for (const t of texts) {
      upsert.run(t.repo, t.number, t.title, t.body, t.updatedAt, t.fetchedAt, t.state, t.isDraft ? 1 : 0);
    }
  })();
}

/**
 * Which of `pulls` need fetching: no stored text, or the PR was updated after the stored
 * text's `updatedAt`. Returned in input order.
 */
export function stalePrTexts(
  db: Database,
  repo: string,
  pulls: readonly { number: number; updatedAt: string }[],
): number[] {
  const stored = getPrTexts(
    db,
    repo,
    pulls.map((p) => p.number),
  );
  return pulls
    .filter((p) => {
      const t = stored.get(p.number);
      return t === undefined || t.updatedAt < p.updatedAt;
    })
    .map((p) => p.number);
}

export function deletePrTexts(db: Database, repo: string, numbers: number[]): void {
  db.query("DELETE FROM pr_texts WHERE repo = ? AND number IN (SELECT value FROM json_each(?))").run(
    repo,
    JSON.stringify(numbers),
  );
}
