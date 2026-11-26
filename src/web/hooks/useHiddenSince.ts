import { useEffect, useRef, useState } from "react";

const STORAGE_KEY = "forgesight.hiddenLastLooked";
const FIRST_VISIT_WINDOW_MS = 24 * 60 * 60 * 1000;

function readLastLooked(): string | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value !== null && !Number.isNaN(Date.parse(value)) ? value : null;
  } catch {
    return null;
  }
}

function saveLastLooked(): void {
  try {
    localStorage.setItem(STORAGE_KEY, new Date().toISOString());
  } catch {
    // Storage can be unavailable (private mode, quota); the next visit falls back to the last day.
  }
}

/**
 * When the Hidden view was last open, read once on entering it (the last 24 hours on a first visit).
 * The stored time moves to now on entering and leaving the view, and when the page closes while on it.
 * Null while the view is not open, and during SSR.
 */
export function useHiddenSince(active: boolean): string | null {
  const [since, setSince] = useState<string | null>(null);
  // Kept across StrictMode's second effect run, which would otherwise read back the time just saved.
  const readRef = useRef<string | null>(null);

  useEffect(() => {
    if (!active) {
      readRef.current = null;
      setSince(null);
      return;
    }
    readRef.current ??= readLastLooked() ?? new Date(Date.now() - FIRST_VISIT_WINDOW_MS).toISOString();
    setSince(readRef.current);
    saveLastLooked();
    window.addEventListener("pagehide", saveLastLooked);
    return () => {
      window.removeEventListener("pagehide", saveLastLooked);
      saveLastLooked();
    };
  }, [active]);

  return since;
}
