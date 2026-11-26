import { useEffect } from "react";
import type { Section } from "../../core/index.ts";
import { useAppStore } from "../store/hooks.ts";
import { SECTIONS } from "../store/types.ts";
import { takeHistoryPush } from "../store/history.ts";
import {
  restoreHistory,
  selectSelectedRow,
  urlStateRestored,
  type UrlState,
  type ViewRootState,
} from "../store/view.ts";

function isSection(value: string | null): value is Section {
  return SECTIONS.some((s) => s === value);
}

export function parseUrlState(search: string): UrlState {
  const params = new URLSearchParams(search);
  const state: UrlState = {};
  const section = params.get("section");
  if (isSection(section)) state.section = section;
  const repo = params.get("repo");
  if (repo) state.repo = repo;
  const sel = params.get("sel");
  if (sel) state.selectedKey = sel;
  return state;
}

export function urlSearchFor(state: ViewRootState): string {
  const params = new URLSearchParams();
  params.set("section", state.view.section);
  if (state.view.repo) params.set("repo", state.view.repo);
  const key = selectSelectedRow(state)?.key ?? state.view.selectedKey;
  if (key) params.set("sel", key);
  return `?${params}`;
}

/**
 * Restores section, repo and selection from the URL on mount, then mirrors them back: a click that
 * navigates adds a history entry, other changes replace the current one. Back and Forward restore
 * the entry's view.
 */
export function useUrlState(): void {
  const store = useAppStore();

  useEffect(() => {
    store.dispatch(urlStateRestored(parseUrlState(window.location.search)));

    let last = window.location.search;
    const sync = () => {
      const search = urlSearchFor(store.getState());
      if (search === last) return;
      last = search;
      const url = `${window.location.pathname}${search}`;
      if (takeHistoryPush()) window.history.pushState(null, "", url);
      else window.history.replaceState(window.history.state, "", url);
    };
    const onPopState = () => {
      last = window.location.search;
      store.dispatch(restoreHistory(parseUrlState(window.location.search)));
    };
    sync();
    const unsubscribe = store.subscribe(sync);
    window.addEventListener("popstate", onPopState);
    return () => {
      unsubscribe();
      window.removeEventListener("popstate", onPopState);
    };
  }, [store]);
}
