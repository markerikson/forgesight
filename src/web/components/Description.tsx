import { useEffect, useRef, useState } from "react";
import { Markdown } from "./Markdown.tsx";
import styles from "./Preview.module.css";

/**
 * A PR or issue description. It starts open, and long bodies are cut to a fixed height until
 * "Show more" is clicked. `plain` bodies are GitHub's plain-text rendering, shown as-is rather
 * than as Markdown; `note` follows the body.
 */
export function Description({
  body,
  label = "Description",
  plain = false,
  note,
}: {
  body: string;
  label?: string;
  plain?: boolean;
  note?: string | undefined;
}) {
  const [open, setOpen] = useState(true);
  const [full, setFull] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const content = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = content.current;
    if (!open || !el) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    for (const child of el.children) observer.observe(child);
    return () => observer.disconnect();
  }, [open, body]);

  return (
    <div className={styles.description}>
      <button
        type="button"
        className={styles.descriptionToggle}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden>{open ? "▾" : "▸"}</span> {label}
      </button>
      {open && (
        <>
          <div ref={content} className={full ? undefined : `${styles.descriptionClamp} ${overflows ? styles.faded : ""}`}>
            {plain ? <p className={styles.plainBody}>{body}</p> : <Markdown source={body} />}
          </div>
          {note && <p className={styles.descriptionNote}>{note}</p>}
          {(overflows || full) && (
            <button type="button" className={styles.showMore} onClick={() => setFull((value) => !value)}>
              {full ? "Show less" : "Show more"}
            </button>
          )}
        </>
      )}
    </div>
  );
}
