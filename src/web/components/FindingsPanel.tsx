import { useState } from "react";
import type { Finding, SubjectDetail } from "../../core/index.ts";
import { buildCopyMarkdown, copyableFindings, severityWeight } from "../../core/findings/index.ts";
import { useAppDispatch } from "../store/hooks.ts";
import { toastShown } from "../store/view.ts";
import styles from "./FindingsPanel.module.css";

const TOOL_NAME = { diffloupe: "DiffLoupe", coderabbit: "CodeRabbit" } as const;

function tone(finding: Finding): string | undefined {
  const weight = severityWeight(finding.severity);
  if (weight >= 4) return styles.blocker;
  if (weight >= 3) return styles.serious;
  return undefined;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Copies the subject's findings as Markdown for a coding agent, outstanding only unless asked. */
export function CopyFindings({ subject }: { subject: SubjectDetail }) {
  const dispatch = useAppDispatch();
  const [menu, setMenu] = useState(false);
  const findings = subject.findings ?? [];
  const outstanding = copyableFindings(findings, false).length;
  const withStale = copyableFindings(findings, true).length;
  if (withStale === 0) return null;

  const copy = (includeStale: boolean) => {
    setMenu(false);
    const count = includeStale ? withStale : outstanding;
    const text = buildCopyMarkdown({
      repo: subject.header.repo,
      number: subject.header.number ?? 0,
      title: subject.header.title,
      findings,
      includeStale,
    });
    navigator.clipboard.writeText(text).then(
      () => dispatch(toastShown(`Copied ${plural(count, "finding")}`)),
      () => dispatch(toastShown("Could not copy findings", { kind: "error" })),
    );
  };

  return (
    <span className={styles.split}>
      <button
        type="button"
        title="Copy outstanding findings as Markdown"
        disabled={outstanding === 0}
        onClick={() => copy(false)}
      >
        Copy findings
      </button>
      <button
        type="button"
        aria-label="More copy options"
        aria-haspopup="menu"
        aria-expanded={menu}
        onClick={() => setMenu((open) => !open)}
      >
        ▾
      </button>
      {menu && (
        <>
          <div className={styles.backdrop} onClick={() => setMenu(false)} />
          <div className={styles.menu} role="menu">
            <button type="button" role="menuitem" onClick={() => copy(true)}>
              Copy with stale ({withStale})
            </button>
          </div>
        </>
      )}
    </span>
  );
}

/**
 * Review-bot findings on the subject: outstanding first, then stale, with a count of the rest.
 * On a merged or closed PR the list is history: what the bots left open when it stopped changing.
 */
export function FindingsPanel({ findings, open }: { findings: readonly Finding[]; open: boolean }) {
  const listed = findings.filter((f) => f.status === "outstanding" || f.status === "stale");
  const fixed = findings.filter((f) => f.status === "fixed").length;
  const resolved = findings.filter((f) => f.status === "resolved").length;
  if (findings.length === 0) return null;
  const rest = [fixed > 0 ? `${fixed} fixed` : null, resolved > 0 ? `${resolved} resolved` : null].filter(
    (part) => part !== null,
  );

  return (
    <section className={styles.panel} aria-label="Review findings">
      <h3 className={styles.heading}>
        {open ? "Findings" : "Findings at the last review"}
        {rest.length > 0 && <span className={styles.rest}>{rest.join(", ")}</span>}
      </h3>
      {listed.length > 0 && (
        <ul className={styles.list}>
          {listed.map((f) => (
            <li key={`${f.tool}:${f.id}`} className={f.status === "stale" || !open ? styles.stale : undefined}>
              <span className={`${styles.severity} ${tone(f) ?? ""}`}>{f.label}</span>
              <span className={styles.tool}>{TOOL_NAME[f.tool]}</span>
              {open && f.isNew && f.status === "outstanding" && <span className={styles.isNew}>new</span>}
              <span className={styles.title}>{f.title}</span>
              {f.file && (
                <span className={styles.where}>
                  {f.url ? (
                    <a href={f.url} target="_blank" rel="noopener noreferrer">
                      {f.file}
                      {f.line !== null && `:${f.line}`}
                    </a>
                  ) : (
                    <>
                      {f.file}
                      {f.line !== null && `:${f.line}`}
                    </>
                  )}
                </span>
              )}
              {f.status === "stale" && <span className={styles.note}>{f.note ?? "code changed since the review"}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
