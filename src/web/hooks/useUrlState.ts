import { useEffect } from "react";
import type { Section } from "../../core/index.ts";
import { useAppStore } from "../store/hooks.ts";
import { SECTIONS } from "../store/types.ts";
import { selectSelectedRow, urlStateRestored, type UrlState, type ViewRootState } from "../store/view.ts";

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

/** Restores section, repo and selection from the URL on mount, then mirrors them back with replaceState. */
export function useUrlState(): void {
  const store = useAppStore();

  useEffect(() => {
    store.dispatch(urlStateRestored(parseUrlState(window.location.search)));

    let last = window.location.search;
    const sync = () => {
      const search = urlSearchFor(store.getState());
      if (search === last) return;
      last = search;
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${search}`);
    };
    sync();
    return store.subscribe(sync);
  }, [store]);
}
