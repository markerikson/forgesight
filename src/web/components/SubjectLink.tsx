import type { MouseEvent, ReactNode } from "react";
import { githubUrlForKey, isPlainClick } from "../links.ts";
import { useAppDispatch } from "../store/hooks.ts";
import { navigate, openSubject } from "../store/view.ts";
import styles from "./SubjectLink.module.css";

/** Small link that always opens `url` on GitHub in a new tab. */
export function GitHubIcon({ url }: { url: string }) {
  return (
    <a
      className={styles.github}
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title="Open on GitHub"
      aria-label="Open on GitHub"
      onClick={(e) => e.stopPropagation()}
    >
      ↗
    </a>
  );
}

interface Props {
  subjectKey: string;
  /** GitHub page; defaults to the one for `subjectKey`. */
  url?: string | null;
  children: ReactNode;
  className?: string | undefined;
  title?: string | undefined;
}

/**
 * Link to a subject: a plain click opens it in the app when the inbox has it, and otherwise the
 * browser follows the link to GitHub. The ↗ icon after it always opens GitHub.
 */
export function SubjectLink({ subjectKey, url, children, className, title }: Props) {
  const dispatch = useAppDispatch();
  const href = url ?? githubUrlForKey(subjectKey);
  const onClick = (e: MouseEvent<HTMLElement>) => {
    e.stopPropagation();
    if (!isPlainClick(e)) return;
    if (dispatch(navigate(openSubject(subjectKey)))) e.preventDefault();
  };
  if (href === null) {
    return (
      <button type="button" className={`${styles.link} ${className ?? ""}`} title={title} onClick={onClick}>
        {children}
      </button>
    );
  }
  return (
    <span className={styles.wrap}>
      <a
        className={`${styles.link} ${className ?? ""}`}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        title={title}
        onClick={onClick}
      >
        {children}
      </a>
      <GitHubIcon url={href} />
    </span>
  );
}
