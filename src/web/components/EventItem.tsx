import type { ViewEvent } from "../../core/index.ts";
import { describeEvent, eventUrl } from "../events.ts";
import { relativeTime } from "../format.ts";
import { Markdown } from "./Markdown.tsx";
import styles from "./EventItem.module.css";

interface Props {
  event: ViewEvent;
  now: number | null;
  /** Show the markdown body; collapsed-group items render as one line. */
  withBody: boolean;
}

export function EventItem({ event, now, withBody }: Props) {
  const url = eventUrl(event);
  const body = withBody ? (event.body ?? event.data.firstComment?.body) : undefined;
  return (
    <div className={`${styles.event} ${event.isNew ? styles.new : ""}`}>
      <div className={styles.line}>
        <span className={styles.actor}>
          {event.actor?.login ?? "someone"}
          {event.actor?.isBot && <span className={styles.bot}>bot</span>}
        </span>
        <span className={styles.what}>{describeEvent(event)}</span>
        {now !== null && (
          <time className={styles.time} dateTime={event.at} title={event.at}>
            {url ? (
              <a href={url} target="_blank" rel="noopener noreferrer">
                {relativeTime(event.at, now)}
              </a>
            ) : (
              relativeTime(event.at, now)
            )}
          </time>
        )}
      </div>
      {body && (
        <div className={styles.body}>
          <Markdown source={body} />
        </div>
      )}
    </div>
  );
}
