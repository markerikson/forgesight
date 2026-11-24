import { useEffect, useState } from "react";
import { renderMarkdown } from "../markdown.ts";
import styles from "./Markdown.module.css";

/**
 * Sanitized GitHub markdown. DOMPurify needs a DOM, so the server render and the first client
 * render show the raw text and the HTML replaces it after mount.
 */
export function Markdown({ source }: { source: string }) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    setHtml(renderMarkdown(source));
  }, [source]);

  if (html === null) return <div className={`${styles.markdown} ${styles.raw}`}>{source}</div>;
  return <div className={styles.markdown} dangerouslySetInnerHTML={{ __html: html }} />;
}
