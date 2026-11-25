import { useEffect } from "react";
import { useAppDispatch, useAppSelector } from "../store/hooks.ts";
import { undoOp } from "../store/state-api.ts";
import { toastDismissed } from "../store/view.ts";
import styles from "./Toast.module.css";

export const TOAST_MS = 10_000;

export function Toast() {
  const dispatch = useAppDispatch();
  const toast = useAppSelector((state) => state.view.toast);
  const id = toast?.id;

  useEffect(() => {
    if (id === undefined) return;
    const timer = setTimeout(() => dispatch(toastDismissed(id)), TOAST_MS);
    return () => clearTimeout(timer);
  }, [dispatch, id]);

  if (!toast) return null;
  const { opId } = toast;
  return (
    <div className={`${styles.toast} ${toast.kind === "error" ? styles.error : ""}`} role="status">
      <span>{toast.message}</span>
      {opId !== undefined && (
        <button type="button" className={styles.button} onClick={() => dispatch(undoOp(opId))}>
          Undo
        </button>
      )}
      <button
        type="button"
        className={styles.close}
        aria-label="Dismiss"
        onClick={() => dispatch(toastDismissed(toast.id))}
      >
        ×
      </button>
    </div>
  );
}
