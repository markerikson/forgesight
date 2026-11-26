let depth = 0;
let pushed = false;

/**
 * Runs `fn` as one user navigation: the first URL change it causes adds a browser history entry,
 * and later changes in the same call update that entry. Changes outside a navigation (j/k, a poll
 * moving the selection) replace the current entry.
 */
export function asNavigation<R>(fn: () => R): R {
  if (depth === 0) pushed = false;
  depth += 1;
  try {
    return fn();
  } finally {
    depth -= 1;
  }
}

/** Whether the URL change being written should add a history entry; true once per navigation. */
export function takeHistoryPush(): boolean {
  if (depth === 0 || pushed) return false;
  pushed = true;
  return true;
}
