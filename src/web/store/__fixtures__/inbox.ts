import { configureStore } from "@reduxjs/toolkit";
import type { InboxEntry, InboxGroup, InboxPayload, InboxRow, Section } from "../../../core/index.ts";
import { api } from "../api.ts";
import { viewSlice } from "../view.ts";

export function row(key: string, section: Section, repo = "acme/app", extra: Partial<InboxRow> = {}): InboxRow {
  return {
    key,
    repo,
    number: 1,
    kind: "pr",
    title: key,
    url: null,
    author: null,
    state: "OPEN",
    draft: false,
    merged: false,
    ciState: null,
    reviewDecision: null,
    latestActor: null,
    section,
    reasons: [],
    summaryLine: "",
    newMeaningfulCount: 0,
    hiddenStats: { pushes: 0, merged: 0, closed: 0 },
    sortAt: "2026-11-01T00:00:00Z",
    snoozeUntil: null,
    unread: false,
    enrichError: null,
    findings: [],
    ...extra,
  };
}

export function group(id: string, members: InboxRow[], extra: Partial<InboxGroup> = {}): InboxGroup {
  return {
    kind: "workstream",
    id,
    repo: members[0]?.repo ?? "acme/app",
    name: `Stack ${id}`,
    summary: null,
    priority: "normal",
    isNew: false,
    section: members.some((m) => m.section === "waiting") ? "waiting" : "updates",
    sortAt: members.map((m) => m.sortAt).sort().at(-1) ?? "",
    members,
    memberKeys: members.map((m) => m.key),
    moreCount: 0,
    closedByAuthor: 0,
    closed: false,
    snoozed: false,
    snoozeUntil: null,
    ...extra,
  };
}

export function payload(rows: InboxEntry[]): InboxPayload {
  return {
    rows,
    sidebar: {
      sections: { waiting: 0, updates: 0, snoozed: 0, hidden: 0 },
      repos: [
        { repo: "acme/app", waiting: 2, updates: 0 },
        { repo: "acme/lib", waiting: 1, updates: 1 },
      ],
    },
    countLines: [],
    generatedAt: "2026-11-01T00:00:00Z",
  };
}

export function storeWith(rows: InboxEntry[], includeHidden = false) {
  const store = configureStore({
    reducer: { [api.reducerPath]: api.reducer, view: viewSlice.reducer },
    middleware: (gDM) => gDM().concat(api.middleware),
  });
  store.dispatch(
    api.util.upsertQueryEntries([{ endpointName: "getInbox", arg: { includeHidden }, value: payload(rows) }]),
  );
  return store;
}
