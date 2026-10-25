import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./utilities.css", import.meta.url), "utf8");

describe("utilities.css: Select", () => {
  it("defines max-h-available from the Radix available height", () => {
    expect(css).toMatch(
      /@utility max-h-available \{\s*max-height: var\(--radix-select-content-available-height, var\(--app-viewport-height, 100dvh\)\);\s*\}/,
    );
  });

  it("shows a thin scrollbar on the Select viewport with two attributes", () => {
    expect(css).toMatch(
      /\[data-radix-select-viewport\]\[data-slot="select-viewport"\] \{\s*scrollbar-width: thin;\s*scrollbar-color: var\(--border-strong\) transparent;\s*\}/,
    );
    expect(css).toMatch(
      /\[data-radix-select-viewport\]\[data-slot="select-viewport"\]::-webkit-scrollbar \{\s*display: block;\s*width: var\(--spacing-s2\);\s*\}/,
    );
  });
});

describe("utilities.css: label-hud", () => {
  it("label-hud is 11 px, weight 600, 0.08em, on the label-transform variable", () => {
    expect(css).toMatch(
      /@utility label-hud \{\s*font-family: var\(--font-code\);\s*font-size: 0\.6875rem;\s*font-weight: 600;\s*letter-spacing: 0\.08em;\s*text-transform: var\(--label-transform\);\s*\}/,
    );
  });
});

describe("utilities.css: browser surfaces", () => {
  it("selection, caret and scrollbars read tokens", () => {
    expect(css).toMatch(
      /::selection \{\s*background-color: color-mix\(in srgb, var\(--agent\) 30%, transparent\);\s*\}/,
    );
    expect(css).toMatch(
      /html \{\s*caret-color: var\(--you\);\s*scrollbar-color: var\(--border-strong\) transparent;\s*\}/,
    );
  });
});
