import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";
import { type InboxPayload, isGroup, type SubjectDetail } from "../../core/index.ts";
import type { StatusPayload } from "../../server/handlers/status.ts";

export interface InboxArg {
  includeHidden: boolean;
}

/** `owner/repo#123` → `owner/repo/123`; `owner/repo@<threadId>` → `owner/repo/@<threadId>`. */
export function subjectPath(key: string): string {
  const match = /^([^/]+)\/([^#@]+)([#@])(.+)$/.exec(key);
  if (!match) throw new Error(`Bad subject key: ${key}`);
  const [, owner = "", repo = "", sep, rest = ""] = match;
  const last = sep === "#" ? rest : `@${rest}`;
  return [owner, repo, last].map(encodeURIComponent).join("/");
}

export const api = createApi({
  baseQuery: fetchBaseQuery({ baseUrl: "/api" }),
  tagTypes: ["Inbox", "Subject", "Status", "Workstream"],
  refetchOnFocus: true,
  endpoints: (build) => ({
    getInbox: build.query<InboxPayload, InboxArg>({
      query: ({ includeHidden }) => `inbox?includeHidden=${includeHidden ? 1 : 0}`,
      providesTags: (result) => {
        const tags: { type: "Inbox" | "Subject" | "Workstream"; id: string }[] = [{ type: "Inbox", id: "LIST" }];
        for (const entry of result?.rows ?? []) {
          if (!isGroup(entry)) {
            tags.push({ type: "Subject", id: entry.key });
            continue;
          }
          tags.push({ type: "Workstream", id: entry.id });
          for (const m of entry.members) tags.push({ type: "Subject", id: m.key });
        }
        return tags;
      },
    }),
    getSubject: build.query<SubjectDetail, string>({
      query: (key) => `subjects/${subjectPath(key)}`,
      providesTags: (result, _error, key) => [
        { type: "Subject", id: key },
        ...(result?.workstream ? [{ type: "Workstream" as const, id: result.workstream.id }] : []),
      ],
    }),
    getStatus: build.query<StatusPayload, void>({
      query: () => "status",
      providesTags: ["Status"],
    }),
  }),
});

export const { useGetInboxQuery, useGetSubjectQuery, useGetStatusQuery, usePrefetch } = api;

/** While the event stream is down, the inbox and status poll on this interval. */
export const POLL_MS = 60_000;
