import { type KeyboardEvent, useState } from "react";
import { useGetWorkstreamsQuery } from "../store/api.ts";
import styles from "./SnoozeMenu.module.css";
import pickerStyles from "./WorkstreamPicker.module.css";

interface Props {
  repo: string;
  title: string;
  /** The workstream the choice acts on, left out of the list. */
  excludeId?: string;
  anchor: { top: number; left: number } | null;
  onChoose: (id: string) => void;
  onClose: () => void;
}

/** A searchable list of the repo's open workstreams. */
export function WorkstreamPicker({ repo, title, excludeId, anchor, onChoose, onClose }: Props) {
  const [query, setQuery] = useState("");
  const { data, isLoading, isError } = useGetWorkstreamsQuery(repo, { refetchOnMountOrArgChange: true });
  const needle = query.trim().toLowerCase();
  const choices = (data?.workstreams ?? [])
    .filter((ws) => ws.id !== excludeId && !ws.closed)
    .filter((ws) => needle === "" || ws.name.toLowerCase().includes(needle) || ws.author.toLowerCase().includes(needle))
    .sort((a, b) => a.name.localeCompare(b.name));

  const choose = (id: string) => {
    onClose();
    onChoose(id);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") onClose();
    else if (e.key === "Enter" && choices[0]) choose(choices[0].id);
  };

  return (
    <div
      className={styles.backdrop}
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        className={`${styles.menu} ${anchor ? styles.anchored : ""}`}
        style={anchor ?? undefined}
        role="dialog"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.title}>{title}</div>
        <input
          className={pickerStyles.search}
          type="search"
          placeholder="Filter by name or author"
          aria-label="Filter workstreams"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          // biome-ignore lint/a11y/noAutofocus: the picker opens to type a filter
          autoFocus
        />
        <div className={pickerStyles.list} role="listbox" aria-label="Workstreams">
          {isLoading && <div className={pickerStyles.empty}>Loading…</div>}
          {isError && <div className={pickerStyles.empty}>Could not load workstreams</div>}
          {data && choices.length === 0 && (
            <div className={pickerStyles.empty}>{needle ? "No match" : "No other workstreams in this repo"}</div>
          )}
          {choices.map((ws) => (
            <button
              key={ws.id}
              type="button"
              role="option"
              aria-selected={false}
              className={`${styles.item} ${pickerStyles.choice}`}
              onClick={() => choose(ws.id)}
            >
              <span className={pickerStyles.name}>{ws.name}</span>
              <span className={pickerStyles.meta}>
                {ws.author} · {ws.members.length} PRs
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
