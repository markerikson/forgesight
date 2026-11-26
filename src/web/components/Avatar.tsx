import { useState } from "react";
import { avatarUrls } from "../format.ts";
import styles from "./Avatar.module.css";

/**
 * A 16px round avatar. Tries each candidate URL in turn (a bot's app avatar lives under a
 * different URL than a user's) and renders nothing once they all fail.
 */
export function Avatar({ login, isBot = null }: { login: string; isBot?: boolean | null }) {
  const urls = avatarUrls(login, isBot);
  const [failed, setFailed] = useState({ login, count: 0 });
  const count = failed.login === login ? failed.count : 0;
  const src = urls[count];
  if (!src) return null;
  return (
    <img
      key={src}
      className={styles.avatar}
      src={src}
      alt={login}
      width={16}
      height={16}
      loading="lazy"
      decoding="async"
      onError={() => setFailed({ login, count: count + 1 })}
    />
  );
}
