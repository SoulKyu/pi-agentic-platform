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
