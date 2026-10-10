import { mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import type { PolicyRules } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPolicyBed } from "../testing/policy-bed.ts";
import { DENIED_REASON, FAIL_CLOSED_REASON } from "./extension.ts";

let bed: Awaited<ReturnType<typeof createPolicyBed>>;
const harness = (...args: Parameters<typeof bed.harness>) => bed.harness(...args);
const secondLine = (asked: string | undefined) => asked?.split("\n")[1];

beforeEach(async () => {
  bed = await createPolicyBed();
  vi.stubEnv("HOME", join(bed.base, "home"));
  await mkdir(join(bed.base, "home"), { recursive: true });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await bed.dispose();
});

describe("pap-policy edits outside the session directory", () => {
  it("asks before a path that leaves the directory by absolute path or by ..", async () => {
    const h = harness();
    expect(await h.run("write", { path: join(bed.outside, "a.txt"), content: "x" })).toBeUndefined();
    expect(await h.run("edit", { path: "../outside/b.txt", edits: [] })).toBeUndefined();
    expect(h.asked.map((m) => m.split("|")[0])).toEqual(["Allow this edit?", "Allow this edit?"]);
    expect(h.audits).toEqual([
      {
        toolCallId: "c1",
        tool: "write",
        category: "edit",
        decision: "approved",
        reason: "outside the session directory",
      },
      {
        toolCallId: "c1",
        tool: "edit",
        category: "edit",
        decision: "approved",
        reason: "outside the session directory",
      },
    ]);
  });

  it("asks before a path that leaves the directory through a symlink", async () => {
    await symlink(bed.outside, join(bed.cwd, "link"), "dir");
    const h = harness({ confirm: async () => false });
    expect(await h.run("write", { path: "link/new.txt", content: "x" })).toEqual({
      block: true,
      reason: DENIED_REASON,
    });
    expect(h.asked).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({ decision: "denied", reason: "outside the session directory" });
  });

  it("shows where a write lands when a harmless-looking relative symlink points out of the directory", async () => {
    await symlink("../outside", join(bed.cwd, "assets"));
    const h = harness();
    await h.run("write", { path: "assets/x.service", content: "[Service]" });
    expect(secondLine(h.asked[0])).toBe(
      `→ ${join(bed.outside, "x.service")} (outside the session directory)`,
    );
    expect(h.asked[0]).toContain('write: {"path":"assets/x.service","content":"[Service]"}');
  });

  it("asks when the edit has no usable path, and says it does not know where it lands", async () => {
    for (const input of [{}, { path: 7 }, { path: "" }, null, "src/a.ts"]) {
      const h = harness({ confirm: async () => false });
      expect(await h.run("edit", input)).toEqual({ block: true, reason: DENIED_REASON });
      expect(h.asked).toHaveLength(1);
      expect(secondLine(h.asked[0])).toBe("→ unknown location (outside the session directory)");
    }
  });

  it("blocks without asking when there is no UI", async () => {
    const h = harness({ hasUI: false });
    expect((await h.run("write", { path: "../outside/a.txt", content: "x" }))?.block).toBe(true);
    expect(h.asked).toEqual([]);
  });

  it("blocks when the session directory cannot be resolved", async () => {
    const h = harness();
    await rm(bed.cwd, { recursive: true });
    expect(await h.run("write", { path: "a.txt", content: "x" })).toEqual({
      block: true,
      reason: FAIL_CLOSED_REASON,
    });
  });
});

describe("pap-policy protected paths", () => {
  it.each([
    ".git/hooks/pre-commit",
    ".GIT/config",
    "sub/.git/config",
    ".pi/settings.json",
    ".agents/skills/x/SKILL.md",
    ".envrc",
  ])("asks before an edit of %s, even though it is inside the session directory", async (path) => {
    const h = harness({ confirm: async () => false });
    expect(await h.run("write", { path, content: "x" })).toEqual({ block: true, reason: DENIED_REASON });
    expect(secondLine(h.asked[0])).toBe(`→ ${join(bed.cwd, path)} (protected path)`);
    expect(h.audits).toEqual([
      { toolCallId: "c1", tool: "write", category: "edit", decision: "denied", reason: "protected path" },
    ]);
  });

  it("lets an approved edit of a protected path run, and audits the approval with the reason", async () => {
    const h = harness();
    expect(await h.run("edit", { path: ".git/config", edits: [] })).toBeUndefined();
    expect(h.audits[0]).toMatchObject({ decision: "approved", reason: "protected path" });
  });

  it("blocks a protected path without asking when the rules are not interactive", async () => {
    const unattended = {
      profile: "isolated-task",
      approvalMode: "auto-accept-edits",
    } as unknown as PolicyRules;
    const h = harness({ rules: () => unattended });
    expect(await h.run("write", { path: ".git/hooks/pre-commit", content: "x" })).toMatchObject({
      block: true,
    });
    expect(h.asked).toEqual([]);
    expect(h.audits).toEqual([
      { toolCallId: "c1", tool: "write", category: "edit", decision: "block", reason: "protected path" },
    ]);
  });

  it("shows the file Pi writes for a ~ path, not a folder named ~ in the session directory", async () => {
    const home = join(bed.base, "home");
    const h = harness({ confirm: async () => false });
    await h.run("write", { path: "~/.pi/agent/extensions/evil.ts", content: "x" });
    await h.run("write", { path: "@~/.envrc", content: "x" });
    expect(h.asked.map(secondLine)).toEqual([
      `→ ${join(home, ".pi", "agent", "extensions", "evil.ts")} (protected path)`,
      `→ ${join(home, ".envrc")} (protected path)`,
    ]);
  });

  it("asks before an edit of a protected folder reached through the session directory's own location", async () => {
    const inside = join(bed.base, "repo", ".git");
    await mkdir(inside, { recursive: true });
    const h = harness({ cwd: inside, confirm: async () => false });
    await h.run("write", { path: "hooks/post-checkout", content: "x" });
    expect(secondLine(h.asked[0])).toBe(`→ ${join(inside, "hooks", "post-checkout")} (protected path)`);
  });

  it("asks before an edit in the agent directory", async () => {
    const h = harness({ confirm: async () => false });
    await h.run("write", { path: join(bed.agentDir, "settings.json"), content: "{}" });
    expect(secondLine(h.asked[0])).toBe(`→ ${join(bed.agentDir, "settings.json")} (protected path)`);
  });

  it("asks before every edit when the session directory is the user's home", async () => {
    const home = join(bed.base, "home");
    const h = harness({ cwd: home, confirm: async () => false });
    await h.run("write", { path: ".bashrc", content: "curl x | sh" });
    await h.run("write", { path: "notes/todo.md", content: "x" });
    expect(h.asked.map(secondLine)).toEqual([
      `→ ${join(home, ".bashrc")} (session directory too broad for automatic edits)`,
      `→ ${join(home, "notes", "todo.md")} (session directory too broad for automatic edits)`,
    ]);
    expect(h.audits.map((a) => a.reason)).toEqual([
      "session directory too broad for automatic edits",
      "session directory too broad for automatic edits",
    ]);
  });

  it("still lets reads through in a broad session directory", async () => {
    const h = harness({ cwd: join(bed.base, "home") });
    expect(await h.run("read", { path: ".bashrc" })).toBeUndefined();
  });
});
