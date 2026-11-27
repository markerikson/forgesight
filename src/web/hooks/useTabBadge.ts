import { useEffect } from "react";
import { useAppSelector } from "../store/hooks.ts";
import { selectInbox } from "../store/view.ts";

export function tabTitle(count: number): string {
  return count > 0 ? `Forgesight (${count})` : "Forgesight";
}

function iconLink(): HTMLLinkElement {
  const existing = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (existing) return existing;
  const link = document.createElement("link");
  link.rel = "icon";
  link.type = "image/svg+xml";
  document.head.append(link);
  return link;
}

/** Puts the Waiting + Updates count (the sidebar badges) in the tab title and a dot on the favicon. */
export function useTabBadge(): void {
  const sections = useAppSelector(selectInbox)?.sidebar.sections;
  const count = sections ? sections.waiting + sections.updates : 0;
  useEffect(() => {
    document.title = tabTitle(count);
    iconLink().href = count > 0 ? "/favicon-dot.svg" : "/favicon.svg";
  }, [count]);
}
