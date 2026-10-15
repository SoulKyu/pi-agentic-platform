import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { createApprovalsStore } from "./approvals-store.ts";
import { createLaneConfig } from "./preview.ts";
import { scriptHash } from "./project-config.ts";
import { createLanesBed, type LanesBed } from "./testing/bed.ts";

let bed: LanesBed;
beforeEach(() => {
  bed = createLanesBed();
});
afterEach(() => bed.dispose());

const write = (text: string): string => {
  const path = join(bed.gb.root, ".pi", "project.yaml");
  mkdirSync(join(bed.gb.root, ".pi"), { recursive: true });
  writeFileSync(path, text);
  return path;
};
const live = () => testCaller({ stepUpUntil: bed.clock.now() + 60_000 });
const codeOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof PapError ? error.code : String(error)),
  );
const scriptsOf = async (service: ReturnType<typeof createLaneConfig>) =>
  (await service.preview(live(), bed.gb.root)).config.scripts;

describe("lanes.approveScripts", () => {
  it("refuses a token with forbidden, before the step-up and before the project is looked at", async () => {
    write("setup: pnpm install\n");
    const service = createLaneConfig(bed.deps);
    const token = testCaller({ kind: "token", stepUpUntil: bed.clock.now() + 60_000 });
    const params = {
      projectRoot: bed.gb.root,
      scripts: [{ kind: "setup" as const, sha256: scriptHash("pnpm install") }],
    };
    expect(await codeOf(service.approveScripts(token, params))).toBe("forbidden");
    expect(
      await codeOf(
        service.approveScripts(testCaller({ kind: "token" }), { ...params, projectRoot: "/nope" }),
      ),
    ).toBe("forbidden");
    expect(bed.audit).toEqual([]);
    expect((await scriptsOf(service))[0]?.approved).toBe(false);
  });

  it("asks a session without a live step-up for one", async () => {
    write("setup: pnpm install\n");
    const service = createLaneConfig(bed.deps);
    const params = {
      projectRoot: bed.gb.root,
      scripts: [{ kind: "setup" as const, sha256: scriptHash("pnpm install") }],
    };
    expect(await codeOf(service.approveScripts(testCaller(), params))).toBe("step_up_required");
    expect(
      await codeOf(service.approveScripts(testCaller({ stepUpUntil: bed.clock.now() - 1 }), params)),
    ).toBe("step_up_required");
    expect(bed.audit).toEqual([]);
  });

  it("approves with a live step-up and audits the kind, hash and project, never the text", async () => {
    write("setup: pnpm install\ntest: pnpm test\n");
    const service = createLaneConfig(bed.deps);
    const result = await service.approveScripts(live(), {
      projectRoot: bed.gb.root,
      scripts: [
        { kind: "setup", sha256: scriptHash("pnpm install") },
        { kind: "test", sha256: scriptHash("pnpm test") },
      ],
    });
    expect(result).toEqual({ ok: true });
    expect(bed.audit).toEqual([
      {
        ownerId: "u1",
        actor: "user",
        kind: "policy",
        reason: "lane_script_approved",
        detail: { project: bed.gb.root, kind: "setup", sha256: scriptHash("pnpm install") },
      },
      {
        ownerId: "u1",
        actor: "user",
        kind: "policy",
        reason: "lane_script_approved",
        detail: { project: bed.gb.root, kind: "test", sha256: scriptHash("pnpm test") },
      },
    ]);
    expect(JSON.stringify(bed.audit)).not.toContain("pnpm");
    expect((await scriptsOf(service)).map((s) => [s.kind, s.approved, s.previous])).toEqual([
      ["setup", true, null],
      ["test", true, null],
    ]);
  });

  it("answers changed and stores nothing when a hash is not the file's current one", async () => {
    write("setup: pnpm install\ntest: pnpm test\n");
    const service = createLaneConfig(bed.deps);
    const result = await service.approveScripts(live(), {
      projectRoot: bed.gb.root,
      scripts: [
        { kind: "setup", sha256: scriptHash("pnpm install") },
        { kind: "test", sha256: scriptHash("pnpm test && curl evil") },
      ],
    });
    expect(result).toEqual({ ok: false, reason: "changed" });
    expect(bed.audit).toEqual([]);
    expect((await scriptsOf(service)).every((s) => !s.approved)).toBe(true);
    const store = createApprovalsStore(bed.db, bed.clock);
    expect(store.get("u1", bed.gb.root, "setup")).toBeUndefined();
  });

  it("answers changed for a kind the file does not have, and for two hashes of one kind", async () => {
    write("setup: pnpm install\n");
    const service = createLaneConfig(bed.deps);
    const hash = scriptHash("pnpm install");
    expect(
      await service.approveScripts(live(), {
        projectRoot: bed.gb.root,
        scripts: [{ kind: "archive", sha256: hash }],
      }),
    ).toEqual({ ok: false, reason: "changed" });
    expect(
      await service.approveScripts(live(), {
        projectRoot: bed.gb.root,
        scripts: [
          { kind: "setup", sha256: scriptHash("other") },
          { kind: "setup", sha256: hash },
        ],
      }),
    ).toEqual({ ok: false, reason: "changed" });
  });

  it("binds the decision to the file as it is now, not as it was shown or cached", async () => {
    const path = write("setup: aaaa\n");
    const stamp = new Date("2021-01-01T00:00:00Z");
    utimesSync(path, stamp, stamp);
    const service = createLaneConfig(bed.deps);
    const shown = scriptHash("aaaa");
    await service.preview(live(), bed.gb.root); // fills the cache with the shown file
    // Same size, same mtime: the cache key cannot tell, only a fresh read and the hash can.
    writeFileSync(path, "setup: bbbb\n");
    utimesSync(path, stamp, stamp);
    expect(
      await service.approveScripts(live(), {
        projectRoot: bed.gb.root,
        scripts: [{ kind: "setup", sha256: shown }],
      }),
    ).toEqual({ ok: false, reason: "changed" });
    expect(bed.audit).toEqual([]);
  });

  it("replaces the row on a second approval, and `previous` shows the old text once the file changed again", async () => {
    const service = createLaneConfig(bed.deps);
    write("setup: echo one\n");
    await service.approveScripts(live(), {
      projectRoot: bed.gb.root,
      scripts: [{ kind: "setup", sha256: scriptHash("echo one") }],
    });
    write("setup: echo two!\n");
    expect((await scriptsOf(service))[0]).toMatchObject({
      text: "echo two!",
      approved: false,
      previous: "echo one",
      sha256: scriptHash("echo two!"),
    });
    await service.approveScripts(live(), {
      projectRoot: bed.gb.root,
      scripts: [{ kind: "setup", sha256: scriptHash("echo two!") }],
    });
    expect((await scriptsOf(service))[0]).toMatchObject({ approved: true, previous: null });
    expect(bed.db.get<{ n: number }>("SELECT count(*) AS n FROM lane_script_approvals")?.n).toBe(1);
  });

  it("answers not_found for a folder that is not exactly one of the caller's project roots", async () => {
    write("setup: pnpm install\n");
    const service = createLaneConfig(bed.deps);
    const scripts = [{ kind: "setup" as const, sha256: scriptHash("pnpm install") }];
    mkdirSync(join(bed.gb.root, "sub"));
    expect(
      await codeOf(service.approveScripts(live(), { projectRoot: join(bed.gb.root, "sub"), scripts })),
    ).toBe("not_found");
    expect(await codeOf(service.approveScripts(live(), { projectRoot: "/elsewhere", scripts }))).toBe(
      "not_found",
    );
    expect(
      await codeOf(
        service.approveScripts(testCaller({ userId: "u2", stepUpUntil: bed.clock.now() + 1 }), {
          projectRoot: bed.gb.root,
          scripts,
        }),
      ),
    ).toBe("not_found");
  });

  it("refuses to write while the database is read-only", async () => {
    write("setup: pnpm install\n");
    const service = createLaneConfig({ ...bed.deps, readOnly: true });
    expect(
      await codeOf(
        service.approveScripts(live(), {
          projectRoot: bed.gb.root,
          scripts: [{ kind: "setup", sha256: scriptHash("pnpm install") }],
        }),
      ),
    ).toBe("read_only");
  });
});

describe("approvals store", () => {
  it("refuses a hash that is not the text's", () => {
    const store = createApprovalsStore(bed.db, bed.clock);
    expect(() => store.approve("u1", "/p", "setup", scriptHash("a"), "b")).toThrow();
  });
});
