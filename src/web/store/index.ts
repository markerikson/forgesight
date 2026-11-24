import { configureStore } from "@reduxjs/toolkit";
import { setupListeners } from "@reduxjs/toolkit/query";
import type { StatusPayload } from "../../server/handlers/status.ts";
import { api } from "./api.ts";

export interface InitialData {
  status: StatusPayload;
}

/** One store per browser tab, seeded with what the server rendered so the first paint needs no fetch. */
export function makeStore(initial: InitialData) {
  const store = configureStore({
    reducer: { [api.reducerPath]: api.reducer },
    middleware: (gDM) => gDM().concat(api.middleware),
  });
  store.dispatch(
    api.util.upsertQueryEntries([{ endpointName: "getStatus", arg: undefined, value: initial.status }]),
  );
  return store;
}

export { setupListeners };

export type AppStore = ReturnType<typeof makeStore>;
export type RootState = ReturnType<AppStore["getState"]>;
export type AppDispatch = AppStore["dispatch"];
