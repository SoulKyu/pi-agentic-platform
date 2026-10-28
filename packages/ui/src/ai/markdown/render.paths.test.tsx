// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { click, mount } from "../../testing/dom.ts";
import MarkdownBody from "./render.tsx";
import type { LinkedSpan, PathLinks } from "./reply-tools.ts";

/** A recogniser of `src/x.ts` and `src/x.ts:N`, enough to see where the renderer links. */
function fakeLinks() {
  const open = vi.fn<(span: LinkedSpan) => void>();
  const links: PathLinks = {
    find(text, whole) {
      const pattern = whole ? /^src\/\w+\.ts(?::(\d+))?$/g : /src\/\w+\.ts(?::(\d+))?/g;
      return [...text.matchAll(pattern)].map((match) => ({
        start: match.index,
        end: match.index + match[0].length,
        text: match[0],
        path: `/w/${match[0].replace(/:\d+$/, "")}`,
        line: match[1] === undefined ? null : Number(match[1]),
      }));
    },
    open,
    label: (span) => `Open ${span.text} in Files`,
  };
  return { links, open };
}

const named = (container: ParentNode) =>
  [...container.querySelectorAll("button[data-path-link]")].map((node) => node.getAttribute("aria-label"));

describe("paths in a reply", () => {
  it('a path in a paragraph, a list item and a table cell is a button named "Open <path> in Files"; a click calls open with its path and line', async () => {
    const { links, open } = fakeLinks();
    const text = "Edit src/a.ts:12 now\n\n- and src/b.ts\n\n| f |\n|---|\n| src/c.ts |";
    const page = await mount(<MarkdownBody text={text} pathLinks={links} />);
    expect(named(page.container)).toEqual([
      "Open src/a.ts:12 in Files",
      "Open src/b.ts in Files",
      "Open src/c.ts in Files",
    ]);
    expect(page.container.querySelector("p")?.textContent).toBe("Edit src/a.ts:12 now");
    await click(page.container.querySelector("button[data-path-link]") as Element);
    expect(open).toHaveBeenCalledOnce();
    expect(open.mock.calls[0]?.[0]).toMatchObject({ path: "/w/src/a.ts", line: 12 });
  });

  it("a path in emphasis, strong and a heading links too", async () => {
    const { links } = fakeLinks();
    const page = await mount(
      <MarkdownBody text={"# src/h.ts\n\n**src/s.ts** and *src/e.ts* and ~~src/d.ts~~"} pathLinks={links} />,
    );
    expect(named(page.container)).toHaveLength(4);
  });

  it("a path in a fenced block or inside a link stays text", async () => {
    const { links } = fakeLinks();
    const page = await mount(
      <MarkdownBody
        text={
          "```\nsrc/a.ts\n```\n\n[src/b.ts](https://e.test/x) [**src/d.ts**](https://e.test/y) and https://e.test/src/c.ts"
        }
        pathLinks={links}
      />,
    );
    expect(named(page.container)).toEqual([]);
    expect(page.container.textContent).toContain("src/a.ts");
  });

  it("inline code links only when it is one whole path", async () => {
    const { links } = fakeLinks();
    const page = await mount(<MarkdownBody text={"`src/a.ts:3` and `run src/b.ts`"} pathLinks={links} />);
    expect(named(page.container)).toEqual(["Open src/a.ts:3 in Files"]);
    expect(page.container.querySelector("code button")).not.toBeNull();
  });

  it("a path whose :line grows stays the same button", async () => {
    const { links } = fakeLinks();
    const page = await mount(<MarkdownBody text="see src/a.ts:1" pathLinks={links} />);
    const before = page.container.querySelector("button[data-path-link]");
    await page.rerender(<MarkdownBody text="see src/a.ts:12" pathLinks={links} />);
    const after = page.container.querySelector("button[data-path-link]");
    expect(after?.getAttribute("aria-label")).toBe("Open src/a.ts:12 in Files");
    expect(after).toBe(before);
  });

  it("without pathLinks the DOM is what it was", async () => {
    const { links } = fakeLinks();
    const text = "A reply with **bold**, `code` and a list:\n\n- one\n- two\n\n| a |\n|---|\n| b |";
    const without = await mount(<MarkdownBody text={text} />);
    const withLinks = await mount(<MarkdownBody text={text} pathLinks={links} />);
    expect(withLinks.container.innerHTML).toBe(without.container.innerHTML);
    expect(without.container.innerHTML).toMatchInlineSnapshot(`
      "<div data-markdown-body="" class="flex min-w-0 flex-col gap-s2 whitespace-normal break-words text-chat"><p class="max-w-measure text-pretty">A reply with <strong>bold</strong>, <code class="rounded-sm bg-surface-2 px-s1 font-mono text-code">code</code> and a list:</p>
      <ul class="flex max-w-measure flex-col gap-s1 pl-s4 list-disc">
      <li class="text-pretty">one</li>
      <li class="text-pretty">two</li>
      </ul>
      <div class="overflow-x-auto"><table class="w-full border-collapse text-ui"><thead><tr><th class="border border-border px-s2 py-s1 text-left align-top font-semibold">a</th></tr></thead><tbody><tr><td class="border border-border px-s2 py-s1 text-left align-top">b</td></tr></tbody></table></div></div>"
    `);
  });
});
