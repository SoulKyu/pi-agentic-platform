import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkLiterals, literalsIn } from "./literal-coverage.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));

describe("literal UI strings (DESIGN.md §11)", () => {
  it("finds JSX text and labelling attributes, not code or symbols", () => {
    const found = literalsIn(
      "x.tsx",
      [
        "const a = <p>Save changes</p>;",
        'const b = <button aria-label="Close" />;',
        'const c = <input placeholder="Search" />;',
        "const d = <span>{count} · ⌘</span>;",
        'const e = <div data-slot="button" className="flex" />;',
        'const f = <p>{t("key")}</p>;',
      ].join("\n"),
    );
    expect(found.map((l) => l.text)).toEqual(["Save changes", "Close", "Search"]);
  });

  it("packages/ui and apps/web have none outside the allowlist", () => {
    expect(checkLiterals(REPO).map((l) => `${l.file}:${l.line} ${l.text}`)).toEqual([]);
  });
});
