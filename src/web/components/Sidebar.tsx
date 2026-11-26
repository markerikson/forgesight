import { useAppDispatch, useAppSelector } from "../store/hooks.ts";
import { SECTION_LABELS, SECTIONS } from "../store/types.ts";
import { selectInbox, selectRepoCounts, selectView, showRepo, showSection } from "../store/view.ts";
import { repoShortName } from "../format.ts";
import styles from "./Sidebar.module.css";

const SECTION_KEYS = { waiting: "g w", updates: "g u", snoozed: "g s", hidden: "g h" } as const;

export function Sidebar() {
  const dispatch = useAppDispatch();
  const view = useAppSelector(selectView);
  const inbox = useAppSelector(selectInbox);
  const repos = useAppSelector(selectRepoCounts);
  const counts = inbox?.sidebar.sections;

  return (
    <nav className={styles.sidebar} aria-label="Sections">
      <ul className={styles.group}>
        {SECTIONS.map((section) => (
          <li key={section}>
            <button
              type="button"
              className={`${styles.item} ${view.section === section ? styles.active : ""}`}
              aria-current={view.section === section ? "page" : undefined}
              title={SECTION_KEYS[section]}
              onClick={() => dispatch(showSection(section))}
            >
              <span className={styles.label}>{SECTION_LABELS[section]}</span>
              {counts && <span className={styles.count}>{counts[section]}</span>}
            </button>
          </li>
        ))}
      </ul>
      {repos.length > 0 && (
        <>
          <h2 className={styles.heading}>Repos</h2>
          <ul className={styles.group}>
            <li>
              <button
                type="button"
                className={`${styles.item} ${view.repo === null ? styles.active : ""}`}
                onClick={() => dispatch(showRepo(null))}
              >
                <span className={styles.label}>All</span>
              </button>
            </li>
            {repos.map(({ repo, count }) => (
              <li key={repo}>
                <button
                  type="button"
                  className={`${styles.item} ${view.repo === repo ? styles.active : ""}`}
                  title={repo}
                  onClick={() => dispatch(showRepo(view.repo === repo ? null : repo))}
                >
                  <span className={styles.label}>{repoShortName(repo)}</span>
                  <span className={styles.count}>{count}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </nav>
  );
}
