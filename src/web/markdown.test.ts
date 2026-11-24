import { describe, expect, test } from "bun:test";
import type { WindowLike } from "dompurify";
import { JSDOM } from "jsdom";
import { createMarkdownRenderer } from "./markdown.ts";

const render = createMarkdownRenderer(new JSDOM("").window as unknown as WindowLike);

describe("createMarkdownRenderer", () => {
  test("renders GitHub-flavored markdown", () => {
    const html = render("**bold**\n\n| a | b |\n|---|---|\n| 1 | 2 |");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<table>");
  });

  test("strips scripts, event handlers and javascript: links", () => {
    const html = render('<script>alert(1)</script><img src="x.png" onerror="alert(2)">\n\n[x](javascript:alert(3))');
    expect(html).toContain("<a");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('src="x.png"');
  });

  test("keeps details blocks", () => {
    const html = render("<details><summary>Logs</summary>\n\nbody\n\n</details>");
    expect(html).toContain("<details>");
    expect(html).toContain("<summary>Logs</summary>");
  });

  test("opens links in a new tab without an opener", () => {
    const html = render("[docs](https://example.com)");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});
