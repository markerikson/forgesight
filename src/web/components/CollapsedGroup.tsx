import type { CollapsedGroup as Group } from "../../core/index.ts";
import { useAppDispatch, useAppSelector } from "../store/hooks.ts";
import { groupId, groupsToggled } from "../store/view.ts";
import { EventItem } from "./EventItem.tsx";
import styles from "./CollapsedGroup.module.css";

interface Props {
  subjectKey: string;
  group: Group;
  now: number | null;
}

export function CollapsedGroup({ subjectKey, group, now }: Props) {
  const dispatch = useAppDispatch();
  const first = group.items[0];
  const id = first ? groupId(subjectKey, first.id) : null;
  const expanded = useAppSelector((state) => id !== null && state.view.expandedGroups.includes(id));
  if (!id) return null;

  return (
    <div className={`${styles.group} ${group.isNew ? styles.new : ""}`}>
      <button
        type="button"
        className={styles.toggle}
        aria-expanded={expanded}
        onClick={() => dispatch(groupsToggled([id]))}
      >
        <span className={styles.chevron} aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
        {group.summary}
      </button>
      {expanded && (
        <div className={styles.items}>
          {group.items.map((event) => (
            <EventItem key={event.id} event={event} now={now} withBody={false} />
          ))}
        </div>
      )}
    </div>
  );
}
