import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";
import type { StatusPayload } from "../../server/handlers/status.ts";

export const api = createApi({
  baseQuery: fetchBaseQuery({ baseUrl: "/api" }),
  tagTypes: ["Inbox", "Subject", "Status"],
  refetchOnFocus: true,
  endpoints: (build) => ({
    getStatus: build.query<StatusPayload, void>({
      query: () => "status",
      providesTags: ["Status"],
    }),
  }),
});

export const { useGetStatusQuery } = api;

/** Until SSE lands, polled queries refresh on this interval and on window focus. */
export const POLL_MS = 60_000;
