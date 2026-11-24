import createDOMPurify, { type WindowLike } from "dompurify";
import { Marked } from "marked";

export type RenderMarkdown = (source: string) => string;

/**
 * Comment bodies come from GitHub and may hold raw HTML, so every render goes through DOMPurify.
 * DOMPurify needs a DOM: without one it returns its input unchanged, so only call this in the browser
 * (or with a test window).
 */
export function createMarkdownRenderer(window: WindowLike): RenderMarkdown {
  const purify = createDOMPurify(window);
  purify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A" && node.hasAttribute("href")) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
  const marked = new Marked({ gfm: true, breaks: true });
  return (source) => purify.sanitize(marked.parse(source, { async: false }), { ADD_ATTR: ["target"] });
}

let browserRenderer: RenderMarkdown | undefined;

export function renderMarkdown(source: string): string {
  browserRenderer ??= createMarkdownRenderer(window);
  return browserRenderer(source);
}
