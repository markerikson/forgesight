import type { SubjectOrigin } from "./types.ts";

/** Precedence when a subject is seen through more than one source: thread > stack > open-list. */
export function originRank(origin: SubjectOrigin): number {
  switch (origin) {
    case "thread":
      return 3;
    case "stack":
      return 2;
    case "open-list":
      return 1;
  }
}
