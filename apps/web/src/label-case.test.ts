import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const roots = [
  new URL(".", import.meta.url).pathname,
  new URL("../../../packages/ui/src", import.meta.url).pathname,
];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : [];
  });
}

describe("label case", () => {
  it("leaves the case of every label to `label-hud`, so the Uppercase labels setting reaches it", () => {
    const hardCoded = roots
      .flatMap(sources)
      .filter((file) => /["'`\s](?:uppercase|capitalize)["'`\s]/.test(readFileSync(file, "utf8")));
    expect(hardCoded).toEqual([]);
  });

  it("defines label-hud on the label-transform variable that data-labels switches", () => {
    const css = readFileSync(new URL("../../../packages/ui/src/utilities.css", import.meta.url), "utf8");
    expect(css).toMatch(/@utility label-hud \{[^}]*text-transform: var\(--label-transform\)/);
    const tokens = readFileSync(new URL("../../../packages/ui/src/tokens.css", import.meta.url), "utf8");
    expect(tokens).toMatch(/\[data-labels="sentence"\] \{\s*--label-transform: none;/);
  });
});
