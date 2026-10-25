import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import MarkdownBody, { MAX_MARKDOWN_CHARS } from "./render.tsx";
import { safeHref } from "./safe-url.ts";

const html = (text: string) => renderToStaticMarkup(<MarkdownBody text={text} />);

describe("model markdown is untrusted text (checklist: no HTML or markdown injection)", () => {
  it("never turns raw HTML into elements, and shows it as literal text instead of dropping it", () => {
    const out = html('hi <img src=x onerror="alert(1)"> <script>alert(2)</script> <b>bold</b> **strong**');
    expect(out).not.toMatch(/<img|<script|<b>/);
    expect(out).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(out).toContain("<strong>strong</strong>");
  });

  it("keeps a generic type in prose: use Array<string> here", () => {
    const out = html("use Array<string> here");
    expect(out).toContain("use Array&lt;string&gt; here");
    expect(out).not.toMatch(/<string/);
  });

  it("shows a block of raw HTML on its own line as text, in a paragraph, with no element made from it", () => {
    const out = html("before\n\n<img src=x onerror=alert(1)>\n\nafter");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(out).toMatch(/<p[^>]*>before<\/p>/);
    expect(out).toMatch(/<p[^>]*>after<\/p>/);
  });

  it("leaves HTML inside code spans and fences as the code it is", () => {
    const out = html("`<b>x</b>`\n\n```html\n<div>y</div>\n```");
    expect(out).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(out).toContain("&lt;div&gt;y&lt;/div&gt;");
    expect(out).not.toMatch(/<div>y/);
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

describe("agent prose keeps a readable measure", () => {
  const classOf = (out: string, tag: string) =>
    new RegExp(`<${tag}[^>]*class="([^"]*)"`).exec(out)?.[1] ?? "";
  const measured = (cls: string) => cls.split(" ").includes("max-w-measure");
  const labels = { copy: "Copy code", copied: "Copied" };

  it("paragraphs, lists and quotes carry the prose measure; code blocks and tables do not", () => {
    const out = renderToStaticMarkup(
      <MarkdownBody
        copyLabels={labels}
        text={
          "# Title\n\nA paragraph.\n\n- one\n\n1. two\n\n> quoted\n\n```ts\nconst x = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |"
        }
      />,
    );
    for (const tag of ["p", "ul", "ol", "blockquote"]) expect(measured(classOf(out, tag))).toBe(true);
    expect(out).toContain("Copy code");
    for (const tag of ["pre", "table", "div"]) {
      for (const match of out.matchAll(new RegExp(`<${tag}[^>]*class="([^"]*)"`, "g"))) {
        expect(measured(match[1] ?? "")).toBe(false);
      }
    }
    const heading = /<p class="([^"]*)">Title<\/p>/.exec(out)?.[1] ?? "";
    expect(measured(heading)).toBe(true);
  });

  it("paragraphs and list items wrap pretty", () => {
    const out = html("A paragraph.\n\n- one");
    expect(classOf(out, "p").split(" ")).toContain("text-pretty");
    expect(classOf(out, "li").split(" ")).toContain("text-pretty");
  });

  it("plain text keeps the measure", () => {
    const out = html("x".repeat(MAX_MARKDOWN_CHARS + 1));
    expect(/data-markdown-plain="" class="[^"]*max-w-measure/.test(out)).toBe(true);
  });
});
