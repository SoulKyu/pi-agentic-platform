import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Kbd } from "./Kbd.tsx";

describe("Kbd", () => {
  it("joins mac glyphs with nothing and other platforms with +", () => {
    expect(renderToStaticMarkup(<Kbd keys={["⌘", "K"]} />)).toBe(
      '<kbd data-slot="kbd" class="inline-flex items-center gap-0.5"><kbd class="rounded-sm border border-border-strong bg-surface px-s1 font-mono text-label text-muted">⌘</kbd><kbd class="rounded-sm border border-border-strong bg-surface px-s1 font-mono text-label text-muted">K</kbd></kbd>',
    );
    expect(renderToStaticMarkup(<Kbd keys={["Ctrl", "K"]} joiner="+" />)).toContain("</kbd>+<kbd");
  });
});
