import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(join(import.meta.dirname, "../../styles.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

describe("standalone polish (decision 32, board 12)", () => {
  it("the root does not bounce or pull to refresh, and controls show no touch callout", () => {
    const text = styles;
    expect(text).toMatch(/html\s*,\s*body\s*\{[^}]*overscroll-behavior:\s*none/);
    expect(text).toMatch(/\[data-shell="mobile"\] :is\(button,\s*a\)\s*\{[^}]*-webkit-touch-callout:\s*none/);
  });
});
