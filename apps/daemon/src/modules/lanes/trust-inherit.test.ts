import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitBed, type GitBed } from "../../kernel/testing/git-bed.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { createInheritTrust } from "./trust-inherit.ts";

let bed: GitBed | undefined;
afterEach(() => {
  bed?.dispose();
  bed = undefined;
});

function setup(status: boolean | null | "throws" = true, inherit: boolean | "throws" = true) {
  const gb = createGitBed();
  bed = gb;
  const { logger, lines } = captureLogger();
  const trust = {
    status: vi.fn(async () => {
      if (status === "throws") throw new Error("helper down");
      return status;
    }),
    inherit: vi.fn(async () => {
      if (inherit === "throws") throw new Error("write failed");
      return inherit;
    }),
  };
  const run = createInheritTrust({ git: gb.runner(), logger, trust: () => trust });
  const write = (rel: string, text: string): void => {
    mkdirSync(join(gb.root, rel, ".."), { recursive: true });
    writeFileSync(join(gb.root, rel), text);
  };
  const commit = (message: string): string => {
    gb.git(gb.root, "add", "-A");
    gb.git(gb.root, "commit", "-q", "-m", message);
    return gb.git(gb.root, "rev-parse", "HEAD").trim();
  };
  const lane = (baseOid: string) => ({
    ownerId: "u1",
    projectRoot: gb.root,
    worktree: "/wt/lane",
    baseOid,
    by: { kind: "session" as "session" | "token", credentialId: "dev" },
    root: gb.root,
  });
  return { gb, run, trust, write, commit, lane, lines };
}
const head = (): string => (bed as GitBed).git((bed as GitBed).root, "rev-parse", "HEAD").trim();

describe("trust inheritance", () => {
  it("inherits when the root is trusted and both .pi are missing, with equal skills", async () => {
    const s = setup();
    expect(await s.run(s.lane(head()))).toBe(true);
    expect(s.trust.inherit).toHaveBeenCalledWith("u1", "/wt/lane", s.gb.root, {
      kind: "session",
      credentialId: "dev",
    });
  });

  it("inherits when .pi and .agents/skills are the same tree at the base and at HEAD", async () => {
    const s = setup();
    s.write(".pi/extensions/a.ts", "export {};\n");
    s.write(".agents/skills/x/SKILL.md", "x\n");
    const base = s.commit("pi");
    s.write("later.txt", "unrelated\n");
    s.commit("later");
    expect(await s.run(s.lane(base))).toBe(true);
  });

  it("does not inherit when the .pi tree at the base differs from the main checkout's HEAD", async () => {
    const s = setup();
    s.write(".pi/extensions/a.ts", "export {};\n");
    const base = s.commit("pi one");
    s.write(".pi/extensions/a.ts", "export const changed = 1;\n");
    s.commit("pi two");
    expect(await s.run(s.lane(base))).toBe(false);
    expect(s.trust.inherit).not.toHaveBeenCalled();
  });

  it("compares the trees before it asks the helper pool for the status (T18a-m10)", async () => {
    const s = setup();
    s.write(".pi/extensions/a.ts", "export {};\n");
    const base = s.commit("pi one");
    s.write(".pi/extensions/a.ts", "export const changed = 1;\n");
    s.commit("pi two");
    expect(await s.run(s.lane(base))).toBe(false);
    expect(s.trust.status).not.toHaveBeenCalled();
  });

  it("does not inherit when only one side has .pi (a base without it, a HEAD with it, and the reverse)", async () => {
    const s = setup();
    const before = head();
    s.write(".pi/extensions/a.ts", "export {};\n");
    s.commit("adds .pi");
    expect(await s.run(s.lane(before))).toBe(false);
    expect(s.trust.inherit).not.toHaveBeenCalled();
    const withPi = head();
    s.gb.git(s.gb.root, "rm", "-rq", ".pi");
    s.commit("drops .pi");
    expect(await s.run(s.lane(withPi))).toBe(false);
    expect(s.trust.inherit).not.toHaveBeenCalled();
  });

  it("does not inherit when the skills differ", async () => {
    const s = setup();
    s.write(".agents/skills/x/SKILL.md", "one\n");
    const base = s.commit("skill");
    s.write(".agents/skills/x/SKILL.md", "two\n");
    s.commit("skill two");
    expect(await s.run(s.lane(base))).toBe(false);
  });

  it.each([null, false, "throws" as const])("does not inherit when Pi's decision is %s", async (status) => {
    const s = setup(status);
    expect(await s.run(s.lane(head()))).toBe(false);
    expect(s.trust.inherit).not.toHaveBeenCalled();
  });

  it("answers false and logs when the write fails, and when it throws", async () => {
    expect(
      await (() => {
        const s = setup(true, false);
        return s.run(s.lane(head()));
      })(),
    ).toBe(false);
    const s = setup(true, "throws");
    expect(await s.run(s.lane(head()))).toBe(false);
    expect(s.lines.some((line) => JSON.stringify(line).includes("lane_trust_inherit_failed"))).toBe(true);
  });

  it("inherits only when the base is HEAD or an ancestor of it, whatever the base is called", async () => {
    const s = setup();
    const older = head();
    s.write("main.txt", "m\n");
    s.commit("main moves");
    // Someone else's branch: commits main does not have.
    s.gb.git(s.gb.root, "checkout", "-q", "-b", "feature");
    s.write("feature.txt", "f\n");
    s.commit("feature work");
    s.gb.git(s.gb.root, "update-ref", "refs/remotes/origin/feature", "feature");
    s.gb.git(s.gb.root, "checkout", "-q", "main");
    s.gb.git(s.gb.root, "branch", "pr-checkout", "refs/remotes/origin/feature");
    const oid = (rev: string): string => s.gb.git(s.gb.root, "rev-parse", `${rev}^{commit}`).trim();
    const refused = [
      "refs/remotes/origin/feature",
      "refs/heads/pr-checkout",
      "refs/heads/feature",
      s.gb.git(s.gb.root, "rev-parse", "refs/remotes/origin/feature").trim(),
    ];
    for (const ref of refused) {
      expect(await s.run(s.lane(oid(ref))), ref).toBe(false);
    }
    expect(s.trust.status).not.toHaveBeenCalled();
    expect(s.trust.inherit).not.toHaveBeenCalled();
    expect(await s.run(s.lane(older))).toBe(true);
    expect(await s.run(s.lane(head()))).toBe(true);
  });

  it("lets a token's lane inherit only when its base is the main checkout's HEAD commit", async () => {
    const s = setup();
    const token = { kind: "token" as const, credentialId: "tok-1" };
    const before = head();
    expect(await s.run({ ...s.lane(before), by: token })).toBe(true);
    expect(s.trust.inherit).toHaveBeenLastCalledWith("u1", "/wt/lane", s.gb.root, token);
    s.write("later.txt", "x\n");
    s.commit("later");
    expect(await s.run({ ...s.lane(before), by: token })).toBe(false);
    expect(s.trust.inherit).toHaveBeenCalledTimes(1);
    expect(await s.run({ ...s.lane(head()), by: token })).toBe(true);
    // The browser's own lane from the older commit still inherits (equal trees).
    expect(await s.run(s.lane(before))).toBe(true);
  });

  it("does nothing before the trust port is bound", async () => {
    bed = createGitBed();
    const run = createInheritTrust({
      git: bed.runner(),
      logger: captureLogger().logger,
      trust: () => undefined,
    });
    const lane = {
      ownerId: "u1",
      projectRoot: bed.root,
      worktree: "/wt",
      baseOid: head(),
      by: { kind: "session" as const, credentialId: "dev" },
      root: bed.root,
    };
    expect(await run(lane)).toBe(false);
  });
});
