/** Milliseconds since the epoch, or 0 for an unparseable time. */
export function ms(at: string): number {
  const t = Date.parse(at);
  return Number.isNaN(t) ? 0 : t;
}

/** True when ISO time `a` is strictly later than `b`. Compares instants, not strings. */
export function isAfter(a: string, b: string): boolean {
  return ms(a) > ms(b);
}
