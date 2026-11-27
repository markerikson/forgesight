import { isDoneQuiet } from "./inbox.ts";
import type { InboxRow } from "./pipeline/types.ts";
import type { ItemState, SubjectRecord, ThreadRecord } from "./types.ts";

export interface AutoDoneInput {
  state: Pick<ItemState, "doneAt" | "keepUnread">;
  view: Pick<InboxRow, "section" | "sortAt">;
  subject: Pick<SubjectRecord, "dirtyAt">;
  threads: readonly Pick<ThreadRecord, "threadId" | "updatedAt" | "ghDoneAt">[];
  /** Newest `done` outbox row per thread, by creation time. */
  lastDoneQueuedAt: ReadonlyMap<string, string>;
}

/**
 * Threads to mark done on GitHub again for a subject the user marked Done whose activity
 * since is all noise: GitHub brought the thread back, but the view stays quiet. A subject
 * still waiting for enrichment is skipped, since its newest comments may not be stored yet.
 * A thread gets one write per new activity: a `done` row queued after its last update, sent
 * or not (dry run, failure), stops another until GitHub updates the thread again.
 */
export function autoDoneThreads(input: AutoDoneInput): string[] {
  const { state, view, subject } = input;
  if (state.doneAt === null || state.keepUnread || subject.dirtyAt !== null) return [];
  if (!isDoneQuiet(view, state.doneAt)) return [];
  const doneAt = Date.parse(state.doneAt);
  return input.threads
    .filter((t) => {
      if (t.ghDoneAt !== null) return false;
      const updated = Date.parse(t.updatedAt);
      if (!(updated > doneAt)) return false;
      const queuedAt = input.lastDoneQueuedAt.get(t.threadId);
      return queuedAt === undefined || Date.parse(queuedAt) < updated;
    })
    .map((t) => t.threadId);
}
