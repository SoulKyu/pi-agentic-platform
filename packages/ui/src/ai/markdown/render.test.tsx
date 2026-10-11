import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import MarkdownBody, { MAX_MARKDOWN_CHARS } from "./render.tsx";
import { safeHref } from "./safe-url.ts";

const html = (text: string) => renderToStaticMarkup(<MarkdownBody text={text} />);

describe("model markdown is untrusted text (checklist: no HTML or markdown injection)", () => {
  it("never turns raw HTML into elements", () => {
    const out = html('hi <img src=x onerror="alert(1)"> <script>alert(2)</script> <b>bold</b> **strong**');
    expect(out).not.toMatch(/<img|<script|<b>/);
    expect(out).not.toContain("onerror"); // dropped (skipHtml), not even shown as escaped text
    expect(out).toContain("<strong>strong</strong>");
  });

  it("keeps only absolute http, https and mailto links, opened safely; the others stay text", () => {
    const out = html(
      "[a](https://e.test/x) [b](javascript:alert(1)) [c](/settings) [d](data:text/html,hi) [e](mailto:a@e.test)",
    );
    expect(out).toContain('<a href="https://e.test/x" target="_blank" rel="noopener noreferrer"');
    expect(out).toContain('href="mailto:a@e.test"');
    expect(out).not.toMatch(/href="(?:javascript|data|\/settings)/i);
    for (const text of [">b<", ">c<", ">d<"]) expect(out).toContain(text);
  });

  it("renders obfuscated script links as a span without href, and an allowed link as a safe anchor", () => {
    const bad = html("[x](&#106;avascript:alert(1)) [y](JAVASCRIPT:alert(1))");
    expect(bad).not.toContain("href");
    expect(bad).not.toContain("<a ");
    expect(bad).toContain("<span>x</span>");
    expect(bad).toContain("<span>y</span>");
    const good = html("[ok](https://ok.test/p)");
    expect(good).toContain('<a href="https://ok.test/p" target="_blank" rel="noopener noreferrer"');
  });

  it("never loads an image: it becomes its alt text", () => {
    const out = html("![a cat](https://e.test/cat.png)");
    expect(out).not.toContain("<img");
    expect(out).toContain("a cat");
  });

  it("renders GFM tables, and fenced code as a code block in plain text first", () => {
    const out = html("| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```");
    expect(out).toContain("<table");
    expect(out).toMatch(/<pre[^>]*data-slot="code-block"[^>]*data-lang="ts"/);
    expect(out).toContain("const x = 1;");
    expect(out).toContain("data-markdown-body");
  });

  it("shows text above the cap as plain text, unparsed", () => {
    const long = "**b** ".repeat(Math.ceil(MAX_MARKDOWN_CHARS / 6) + 1);
    expect(long.length).toBeGreaterThan(MAX_MARKDOWN_CHARS);
    const out = html(long);
    expect(out).not.toContain("<strong>");
    expect(out).toContain("data-markdown-plain");
  });
});

describe("safeHref", () => {
  it.each([
    ["https://e.test/a?b=1", "https://e.test/a?b=1"],
    ["http://e.test", "http://e.test/"],
    ["mailto:a@e.test", "mailto:a@e.test"],
    ["javascript:alert(1)", null],
    [" java\tscript:alert(1)", null],
    ["data:text/html,x", null],
    ["JaVaScRiPt:alert(1)", null],
    ["vbscript:msgbox(1)", null],
    ["//evil.test/x", null],
    ["\u0001javascript:alert(1)", null],
    [" javascript:alert(1)", null],
    ["https://ok.test", "https://ok.test/"],
    ["mailto:a@b.test", "mailto:a@b.test"],
    ["/settings", null],
    ["", null],
  ])("%j → %j", (raw, expected) => {
    expect(safeHref(raw)).toBe(expected);
  });
});
