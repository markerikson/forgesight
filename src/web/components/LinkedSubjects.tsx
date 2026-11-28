import type { LinkedSubject, LinkRelation } from "../../core/index.ts";
import { linkName } from "../../core/index.ts";
import { StateIcon } from "./Badges.tsx";
import { SubjectLink } from "./SubjectLink.tsx";
import styles from "./LinkedSubjects.module.css";

function relationLabel(relation: LinkRelation, link: LinkedSubject): string {
  switch (relation) {
    case "closes":
    case "branchRule":
      return "fixes";
    case "closedBy":
      if (link.state === "MERGED") return "fixed by";
      return link.state === "CLOSED" ? "closed PR" : "fix in";
    case "duplicate":
      return "duplicate of";
    case "connected":
      return "linked";
  }
}

function linkState(link: LinkedSubject) {
  return link.state === "OPEN" || link.state === "CLOSED" || link.state === "MERGED" ? link.state : null;
}

/** PRs and issues this subject closes, is closed by, duplicates or is connected to. */
export function LinkedSubjects({ linked, repo }: { linked: readonly LinkedSubject[]; repo: string }) {
  if (linked.length === 0) return null;
  return (
    <section className={styles.box} aria-label="Linked">
      <h3 className={styles.heading}>Linked</h3>
      <ul className={styles.list}>
        {linked.map((link) => {
          const key = `${link.repo}#${link.number}`;
          const state = linkState(link);
          return (
            <li key={key} className={styles.item}>
              <span className={styles.relation}>{relationLabel(link.relation, link)}</span>
              {state && <StateIcon kind={link.kind} state={state} draft={false} merged={state === "MERGED"} />}
              <SubjectLink subjectKey={key} title={link.title}>
                {linkName(link, repo)}
                {link.title && <span className={styles.title}> {link.title}</span>}
              </SubjectLink>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Compact links for an inbox row: just `fixes #12` / `fixed by #34`. */
export function LinkedChips({ linked, repo }: { linked: readonly LinkedSubject[]; repo: string }) {
  return (
    <span className={styles.chips}>
      {linked.map((link) => {
        const key = `${link.repo}#${link.number}`;
        return (
          <span key={key} className={styles.chip}>
            {relationLabel(link.relation, link)}{" "}
            <SubjectLink subjectKey={key} title={link.title}>
              {linkName(link, repo)}
            </SubjectLink>
          </span>
        );
      })}
    </span>
  );
}
