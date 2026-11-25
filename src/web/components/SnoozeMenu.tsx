import { chooseSnooze, menuChoices } from "../store/actions.ts";
import { useAppDispatch, useAppSelector } from "../store/hooks.ts";
import { snoozeMenuClosed } from "../store/view.ts";
import styles from "./SnoozeMenu.module.css";

const MENU_WIDTH = 280;
const MENU_HEIGHT = 260;

/** Places the menu under the button that opened it, kept inside the window. */
export function anchorBelow(el: Element): { top: number; left: number } {
  const rect = el.getBoundingClientRect();
  return {
    top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - MENU_HEIGHT)),
    left: Math.max(8, Math.min(rect.left, window.innerWidth - MENU_WIDTH)),
  };
}

export function SnoozeMenu() {
  const dispatch = useAppDispatch();
  const menu = useAppSelector((state) => state.view.snoozeMenu);
  if (!menu) return null;
  const choices = menuChoices(menu, new Date());
  const title = menu.keys.length > 1 ? `Snooze ${menu.keys.length} items` : "Snooze";
  const position = menu.anchor ? { top: menu.anchor.top, left: menu.anchor.left } : undefined;
  return (
    <div className={styles.backdrop} onClick={() => dispatch(snoozeMenuClosed())}>
      <div
        className={`${styles.menu} ${position ? styles.anchored : ""}`}
        style={position}
        role="menu"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.title}>{title}</div>
        {choices.map((choice, index) => (
          <button
            key={choice.label}
            type="button"
            role="menuitem"
            className={`${styles.item} ${index === menu.index ? styles.active : ""}`}
            onClick={() => dispatch(chooseSnooze(index))}
          >
            <kbd>{index + 1}</kbd>
            {choice.label}
          </button>
        ))}
      </div>
    </div>
  );
}
