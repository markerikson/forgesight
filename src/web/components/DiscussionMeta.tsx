import type { DiscussionInfo } from "../../core/index.ts";
import styles from "./DiscussionMeta.module.css";

/** Category, answer state and truncation note of a discussion, for the preview header. */
export function DiscussionMeta({ info }: { info: DiscussionInfo | undefined }) {
  if (!info) return null;
  const omitted = info.omittedComments + info.omittedReplies;
  return (
    <>
      {info.category && (
        <span className={styles.category}>
          {info.categoryEmoji && <span aria-hidden="true">{emoji(info.categoryEmoji)} </span>}
          {info.category}
        </span>
      )}
      {info.answerable &&
        (info.answerId ? (
          <span className={styles.answered}>answered{info.answeredBy && ` · chosen by ${info.answeredBy}`}</span>
        ) : (
          <span className={styles.unanswered}>unanswered</span>
        ))}
      {omitted > 0 && <span title="Only the latest comments and replies are loaded">{omitted} older not shown</span>}
    </>
  );
}

const EMOJI: Record<string, string> = {
  ":speech_balloon:": "💬",
  ":pray:": "🙏",
  ":bulb:": "💡",
  ":mega:": "📣",
  ":raised_hands:": "🙌",
  ":ballot_box:": "🗳️",
  ":question:": "❓",
};

/** GitHub returns category emoji as shortcodes; show the common ones, drop the rest. */
function emoji(shortcode: string): string {
  return EMOJI[shortcode] ?? "";
}
