import { useEffect, useMemo, useState } from "react";
import { renderMarkdown } from "../markdown.ts";
import styles from "./Markdown.module.css";

let hydrated = false;

/**
 * Sanitized GitHub markdown. DOMPurify needs a DOM, so the server render and the hydration render
 * show the raw text and the HTML replaces it after mount. Components mounted after hydration
 * render the HTML right away.
 */
export function Markdown({ source }: { source: string }) {
  const [mounted, setMounted] = useState(hydrated);

  useEffect(() => {
    hydrated = true;
    setMounted(true);
  }, []);

  const html = useMemo(() => (mounted ? renderMarkdown(source) : null), [mounted, source]);

  if (html === null) return <div className={`${styles.markdown} ${styles.raw}`}>{source}</div>;
  return <div className={styles.markdown} dangerouslySetInnerHTML={{ __html: html }} />;
}
