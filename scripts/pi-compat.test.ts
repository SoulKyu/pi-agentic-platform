import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bumpWorktreeCatalog, parseArgs, planSteps, worktreePath } from "./pi-compat.ts";

describe("parseArgs", () => {
  it("defaults to a full run", () => {
    expect(parseArgs([])).toEqual({ dryRun: false });
  });

  it("reads --dry-run", () => {
    expect(parseArgs(["--dry-run"])).toEqual({ dryRun: true });
  });

  it("refuses anything else, so a typo cannot start a full run", () => {
    expect(() => parseArgs(["--dryrun"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--dry-run", "extra"])).toThrow(/unknown argument/);
  });
});

describe("worktreePath", () => {
  it("is a child of the scratch directory, never the repository", () => {
    expect(worktreePath("/tmp/pap-pi-compat-abc")).toBe(join("/tmp/pap-pi-compat-abc", "tree"));
  });
});

describe("planSteps", () => {
  const tree = "/tmp/pap-pi-compat-abc/tree";
  const names = (heavyLock?: string) =>
    planSteps({ repo: "/repo", tree, heavyLock }).map((step) => [step.command, ...step.args].join(" "));

  it("creates a detached worktree at HEAD from the repository first", () => {
    const [first] = planSteps({ repo: "/repo", tree });
    expect(first).toMatchObject({
      command: "git",
      args: ["worktree", "add", "--detach", tree, "HEAD"],
      cwd: "/repo",
    });
  });

  it("installs, type-checks and tests inside the worktree, in that order", () => {
    expect(names()).toEqual([
      `git worktree add --detach ${tree} HEAD`,
      "pnpm install --no-frozen-lockfile",
      "pnpm typecheck",
      "pnpm test:unit",
      "pnpm test:int",
    ]);
    for (const step of planSteps({ repo: "/repo", tree }).slice(1)) expect(step.cwd).toBe(tree);
  });

  it("never touches the repository after the worktree exists", () => {
    const steps = planSteps({ repo: "/repo", tree });
    expect(steps.filter((step) => step.cwd === "/repo")).toHaveLength(1);
  });

  it("wraps only the integration run in the heavy lock when one is set", () => {
    const list = names("/locks/heavy.lock");
    expect(list.at(-1)).toBe("flock /locks/heavy.lock pnpm test:int");
    expect(list.slice(0, -1)).not.toContain("flock");
    expect(list.filter((line) => line.startsWith("flock"))).toHaveLength(1);
  });

  it("never carries a release age bypass", () => {
    for (const line of names("/locks/heavy.lock")) expect(line).not.toMatch(/release-age/i);
  });
});

describe("bumpWorktreeCatalog", () => {
  it("bumps the worktree's own catalog text, keeping its other lines", () => {
    const tree = mkdtempSync(join(tmpdir(), "pap-tree-"));
    try {
      const head = [
        "catalog:",
        '  "@earendil-works/pi-ai": 1.1.0 # head',
        "  zod: 4.1.0",
        "minimumReleaseAge: 4320",
        "",
      ].join("\n");
      writeFileSync(join(tree, "pnpm-workspace.yaml"), head);
      bumpWorktreeCatalog(tree, "1.2.0");
      expect(readFileSync(join(tree, "pnpm-workspace.yaml"), "utf8")).toBe(head.replace("1.1.0", "1.2.0"));
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });
});
