import type { ViewEvent } from "../../core/index.ts";
import { describeEvent, eventUrl, refText } from "../events.ts";
import { relativeTime } from "../format.ts";
import { Markdown } from "./Markdown.tsx";
import { SubjectLink } from "./SubjectLink.tsx";
import styles from "./EventItem.module.css";

interface Props {
  event: ViewEvent;
  now: number | null;
  /** Show the markdown body; collapsed-group items render as one line. */
  withBody: boolean;
}

/** The event description, with any referenced PR or issue as a link into the app. */
function EventText({ event }: { event: ViewEvent }) {
  const text = describeEvent(event);
  const ref = event.data.ref;
  const label = ref ? refText(ref) : "";
  const at = label ? text.lastIndexOf(label) : -1;
  if (!ref || at === -1) return text;
  const url = `https://github.com/${ref.repo}/${ref.kind === "pr" ? "pull" : "issues"}/${ref.number}`;
  return (
    <>
      {text.slice(0, at)}
      <SubjectLink subjectKey={`${ref.repo}#${ref.number}`} url={url}>
        {label}
      </SubjectLink>
      {text.slice(at + label.length)}
    </>
  );
}

export function EventItem({ event, now, withBody }: Props) {
  const url = eventUrl(event);
  const body = withBody ? (event.body ?? event.data.firstComment?.body) : undefined;
  return (
    <div className={`${styles.event} ${event.isNew ? styles.new : ""}`}>
      <div className={styles.line}>
        <span className={styles.actor}>
          {event.actor?.login ?? (event.kind === "baseChanged" ? "GitHub" : "someone")}
          {event.actor?.isBot && <span className={styles.bot}>bot</span>}
        </span>
        <span className={styles.what}>
          <EventText event={event} />
        </span>
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
