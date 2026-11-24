import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";
import type { StatusPayload } from "../../server/handlers/status.ts";
import type { InboxPayload, SubjectDetail } from "./types.ts";

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
  tagTypes: ["Inbox", "Subject", "Status"],
  refetchOnFocus: true,
  endpoints: (build) => ({
    getInbox: build.query<InboxPayload, InboxArg>({
      query: ({ includeHidden }) => `inbox?includeHidden=${includeHidden ? 1 : 0}`,
      providesTags: (result) => [
        { type: "Inbox", id: "LIST" },
        ...(result?.rows ?? []).map((row) => ({ type: "Subject" as const, id: row.key })),
      ],
    }),
    getSubject: build.query<SubjectDetail, string>({
      query: (key) => `subjects/${subjectPath(key)}`,
      providesTags: (_result, _error, key) => [{ type: "Subject", id: key }],
    }),
    getStatus: build.query<StatusPayload, void>({
      query: () => "status",
      providesTags: ["Status"],
    }),
  }),
});

export const { useGetInboxQuery, useGetSubjectQuery, useGetStatusQuery, usePrefetch } = api;

/** Until SSE lands, polled queries refresh on this interval and on window focus. */
export const POLL_MS = 60_000;
