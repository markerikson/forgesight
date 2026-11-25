import { useAppDispatch, useAppSelector } from "../store/hooks.ts";
import { helpClosed } from "../store/view.ts";
import styles from "./HelpOverlay.module.css";

const SHORTCUTS: [keys: string, action: string][] = [
  ["j / k", "Next / previous thread"],
  ["n / p", "Next (older) / previous round"],
  ["o / Enter", "Open on GitHub"],
  ["x", "Expand or collapse groups in the focused round"],
  ["Space", "Next thread"],
  ["e", "Done"],
  ["s / z", "Snooze (or unsnooze)"],
  ["m", "Mute / unmute"],
  ["Shift+M", "Mute and unsubscribe"],
  ["u", "Keep unread / mark read"],
  ["Shift+Z", "Undo the last change"],
  ["Shift+R", "Check GitHub now"],
  ["g w", "Go to Waiting on me"],
  ["g u", "Go to Updates"],
  ["g s", "Go to Snoozed"],
  ["g h", "Go to Hidden"],
  ["?", "Toggle this help"],
  ["Esc", "Close this help or a menu"],
];

export function HelpOverlay() {
  const dispatch = useAppDispatch();
  const open = useAppSelector((state) => state.view.helpOpen);
  if (!open) return null;
  return (
    <div className={styles.backdrop} onClick={() => dispatch(helpClosed())}>
      <div
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="help-title" className={styles.title}>
          Keyboard shortcuts
        </h2>
        <dl className={styles.list}>
          {SHORTCUTS.map(([keys, action]) => (
            <div key={keys} className={styles.item}>
              <dt>
                <kbd>{keys}</kbd>
              </dt>
              <dd>{action}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
