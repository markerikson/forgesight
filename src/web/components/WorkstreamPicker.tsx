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
  onChoose: (id: string, name: string) => void;
  onClose: () => void;
}

/** A searchable list of the repo's open workstreams. */
export function WorkstreamPicker({ repo, title, excludeId, anchor, onChoose, onClose }: Props) {
  const [query, setQuery] = useState("");
  const { data, isLoading, isError } = useGetWorkstreamsQuery(repo, { refetchOnMountOrArgChange: true });
  const needle = query.trim().toLowerCase();
  const choices = (data?.workstreams ?? [])
    .filter((ws) => ws.id !== excludeId && !ws.closed)
    .filter(
      (ws) =>
        needle === "" || ws.displayName.toLowerCase().includes(needle) || ws.author.toLowerCase().includes(needle),
    )
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  const choose = (id: string, name: string) => {
    onClose();
    onChoose(id, name);
  };
  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && choices[0]) choose(choices[0].id, choices[0].displayName);
  };
  // Keys stay inside the picker so the inbox shortcuts never act on the row behind it.
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (e.key === "Escape") onClose();
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
        className={`${styles.menu} ${pickerStyles.picker} ${anchor ? styles.anchored : ""}`}
        style={anchor ?? undefined}
        role="dialog"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKey}
      >
        <div className={styles.title}>{title}</div>
        <input
          className={pickerStyles.search}
          type="search"
          placeholder="Filter by name or author"
          aria-label="Filter workstreams"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onSearchKey}
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
              onClick={() => choose(ws.id, ws.displayName)}
            >
              <span className={pickerStyles.name} title={ws.displayName}>
                {ws.displayName}
              </span>
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
