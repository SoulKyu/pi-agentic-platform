import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(import.meta.dirname, "..", path), "utf8");

describe("CI configuration", () => {
  it("runs knip as a step that can fail the build (R5)", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toMatch(/^\s+- run: pnpm knip$/m);
    expect(ci).not.toContain("continue-on-error");
  });

  it("makes ripgrep, fd (named fd) and procps available to every job, before the install (R92)", () => {
    const setup = read(".github/actions/setup/action.yml");
    for (const needle of ["ripgrep", "fd-find", "procps", 'ln -s "$(command -v fdfind)" /usr/local/bin/fd']) {
      expect(setup, needle).toContain(needle);
    }
    expect(setup.indexOf("fd-find")).toBeLessThan(setup.indexOf("pnpm install"));
  });

  it("has no browser-test runner left behind (R128: Playwright is not used)", () => {
    const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts;
    expect(Object.keys(scripts)).not.toContain("e2e");
    expect(Object.values(scripts).join("\n")).not.toMatch(/playwright/i);
    const knip = read("knip.json");
    expect(knip).not.toMatch(/playwright|e2e/i);
    expect(read("AGENTS.md")).not.toMatch(/pnpm e2e|playwright/i);
  });
});
