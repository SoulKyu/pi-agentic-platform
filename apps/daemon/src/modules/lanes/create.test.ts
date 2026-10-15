import { join } from "node:path";
import { PapError } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PREPARE_DEADLINE_MS } from "./create.ts";
import { insertLane } from "./testing/lane-rows.ts";
import { type CreateBed, createCreateBed, deferred } from "./testing/create-bed.ts";

let bed: CreateBed | undefined;
afterEach(async () => {
  await bed?.service.shutdown();
  bed?.dispose();
  bed = undefined;
});
const make = (options: Parameters<typeof createCreateBed>[0] = {}): CreateBed =>
  (bed = createCreateBed(options));

const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof PapError ? error.code : String(error)),
  );
const active = (b: CreateBed, id: string) =>
  vi.waitFor(() => expect(b.view(id).state).not.toBe("creating"), { timeout: 5000 });
const lanes = (b: CreateBed) => b.db.all<{ id: string }>("SELECT id FROM lanes");

describe("lanes.create: refusals (phase 1, nothing written)", () => {
  it("refuses a project root the caller does not own, a subfolder, and a folder that is no main checkout", async () => {
    const b = make();
    expect(await codeOf(b.service.create({ ...b.browser(), userId: "u2" }, b.params()))).toBe("not_found");
    expect(
      await codeOf(b.service.create(b.browser(), b.params({ projectRoot: join(b.gb.root, ".pi") }))),
    ).toBe("not_found");
    b.projects.set("u1", [b.gb.dir]);
    expect(await codeOf(b.service.create(b.browser(), b.params({ projectRoot: b.gb.dir })))).toBe(
      "not_found",
    );
    expect(lanes(b)).toEqual([]);
    expect(b.order).toEqual([]);
  });

  it("answers bad_request for an issue on another host", async () => {
    const b = make();
    expect(
      await codeOf(
        b.service.create(
          b.browser(),
          b.params({
            issue: {
              forge: "github",
              url: "https://evil.example/o/r/issues/1",
              number: 1,
              title: "t",
              body: "b",
              state: "open",
              labels: [],
              truncated: false,
            },
          }),
        ),
      ),
    ).toBe("bad_request");
    expect(lanes(b)).toEqual([]);
  });

  it("answers bad_request for a title that is empty once cleaned", async () => {
    const b = make();
    expect(await codeOf(b.service.create(b.browser(), b.params({ title: "   " })))).toBe("bad_request");
  });

  it("answers read_only on a read-only database", async () => {
    const b = make({ readOnly: true });
    expect(await codeOf(b.service.create(b.browser(), b.params()))).toBe("read_only");
  });

  it("refuses an explicit branch that exists with conflict, and uses a new one verbatim", async () => {
    const b = make();
    expect(await codeOf(b.service.create(b.browser(), b.params({ branch: "main" })))).toBe("conflict");
    expect(lanes(b)).toEqual([]);
    const id = await b.create({ branch: "feature/mine" });
    expect(b.view(id).branch).toBe("feature/mine");
  });

  it("refuses a branch that check-ref-format does not echo unchanged", async () => {
    const b = make({
      git: (real) => ({
        run: (root, args, opts) =>
          args[0] === "check-ref-format"
            ? Promise.resolve({ stdout: Buffer.from("rewritten\n"), code: 0 })
            : real.run(root, args, opts),
      }),
    });
    expect(await codeOf(b.service.create(b.browser(), b.params({ branch: "feature/mine" })))).toBe(
      "bad_request",
    );
    expect(await codeOf(b.service.create(b.browser(), b.params()))).toBe("bad_request");
    expect(lanes(b)).toEqual([]);
  });

  it("answers bad_request for an unknown base, and resolves a known one", async () => {
    const b = make();
    expect(await codeOf(b.service.create(b.browser(), b.params({ baseRef: "refs/heads/nope" })))).toBe(
      "bad_request",
    );
    expect(await codeOf(b.service.create(b.browser(), b.params({ baseRef: "f".repeat(40) })))).toBe(
      "bad_request",
    );
    const head = b.gb.git(b.gb.root, "rev-parse", "HEAD").trim();
    const id = await b.create({ baseRef: "refs/heads/main" });
    expect(b.db.get("SELECT base_ref, base_oid FROM lanes WHERE id = $id", { id })).toEqual({
      base_ref: "refs/heads/main",
      base_oid: head,
    });
    const byOid = await b.create({ baseRef: head, title: "By oid" });
    expect(b.db.get("SELECT base_ref, base_oid FROM lanes WHERE id = $id", { id: byOid })).toEqual({
      base_ref: head,
      base_oid: head,
    });
  });

  it("bases a lane on the current branch, or on HEAD's oid when detached", async () => {
    const b = make();
    const head = b.gb.git(b.gb.root, "rev-parse", "HEAD").trim();
    const onBranch = await b.create();
    expect(b.db.get("SELECT base_ref, base_oid FROM lanes WHERE id = $id", { id: onBranch })).toEqual({
      base_ref: "refs/heads/main",
      base_oid: head,
    });
    b.gb.git(b.gb.root, "checkout", "-q", "--detach");
    const detached = await b.create({ title: "Detached" });
    expect(b.db.get("SELECT base_ref, base_oid FROM lanes WHERE id = $id", { id: detached })).toEqual({
      base_ref: head,
      base_oid: head,
    });
  });

  it("answers limit_reached for the 65th non-archived lane, and counts an archived one for nothing", async () => {
    const b = make();
    for (let n = 0; n < 64; n++)
      insertLane(b.db, {
        id: `lane-${String(n).padStart(4, "0")}`,
        worktree: `/w/${n}`,
        projectRoot: b.gb.root,
      });
    expect(await codeOf(b.service.create(b.browser(), b.params()))).toBe("limit_reached");
    expect(lanes(b)).toHaveLength(64);
    b.db.run("UPDATE lanes SET state = 'archived', archived_at = 1 WHERE id = 'lane-0000'");
    expect(await codeOf(b.service.create(b.browser(), b.params()))).toBe("resolved");
  });

  it("answers disk_low when the disk floor says so, capacity for any other failure, and writes no row nor reserves anything", async () => {
    const b = make();
    b.behaviour.diskFloor = () => {
      throw new PapError("disk_low");
    };
    expect(await codeOf(b.service.create(b.browser(), b.params()))).toBe("disk_low");
    b.behaviour.diskFloor = () => {
      throw new Error("anything");
    };
    expect(await codeOf(b.service.create(b.browser(), b.params()))).toBe("capacity");
    expect(lanes(b)).toEqual([]);
    expect(b.order).toEqual([]);
    expect(b.calls.disk).toEqual([join(b.home, "worktrees"), join(b.home, "worktrees")]);
  });
});

describe("lanes.create: branch and id", () => {
  it("names the branch pi/<slug>, takes -2 when it exists, and answers limit_reached after -20", async () => {
    const b = make();
    b.gb.git(b.gb.root, "branch", "pi/add-thing");
    const second = await b.create();
    expect(b.view(second).branch).toBe("pi/add-thing-2");
    for (let n = 2; n <= 20; n++) b.gb.git(b.gb.root, "branch", `pi/add-thing-${n}`);
    expect(await codeOf(b.service.create(b.browser(), b.params()))).toBe("limit_reached");
  });

  it("uses the project's branchPrefix, and writes a lane row that matches the caller", async () => {
    const b = make();
    b.writeConfig("branchPrefix: feat/\n");
    const head = b.gb.git(b.gb.root, "rev-parse", "HEAD").trim();
    const id = await b.create({ title: "Réparer l'été", description: "d" });
    expect(id).toMatch(/^reparer-l-ete-[0-9a-f]{4}$/);
    expect(b.db.get("SELECT * FROM lanes WHERE id = $id", { id })).toMatchObject({
      owner_id: "u1",
      created_by: "session",
      project_root: b.gb.root,
      worktree: join(b.home, "worktrees", id),
      branch: "feat/reparer-l-ete",
      base_oid: head,
      title: "Réparer l'été",
      description: "d",
    });
    const viaToken = await b.create({ title: "Other" }, b.token());
    expect(b.view(viaToken).createdBy).toBe("token");
  });
});

describe("lanes.create: the order (M9-RT-23)", () => {
  it("answers while worktree create is still pending, then creates, copies, readies and activates", async () => {
    const b = make();
    const gate = deferred();
    b.behaviour.worktreeCreate = () => gate.promise;
    const answer = await b.service.create(b.browser(), b.params());
    expect(answer).toEqual({ laneIds: [expect.stringMatching(/^add-thing-[0-9a-f]{4}$/)], fanoutId: null });
    const id = answer.laneIds[0] as string;
    expect(b.view(id).state).toBe("creating");
    expect(b.order).toEqual(["reserve", "create"]);
    gate.resolve();
    await b.service.settled();
    expect(b.order).toEqual(["reserve", "create", "copy", "ready", "session", "prompt"]);
    expect(b.view(id).state).toBe("active");
    expect(b.calls.disk[0]).toBe(join(b.home, "worktrees"));
    expect(b.calls.copy[0]).toEqual({
      root: b.gb.root,
      worktree: join(b.home, "worktrees", id),
      gitDir: "/fake/git/dir",
      denyFolders: ["/denied"],
    });
  });

  it("publishes the lane creating, then active, to its owner", async () => {
    const b = make();
    const id = await b.create();
    await active(b, id);
    await vi.waitFor(() => expect(b.published.map((entry) => entry.event.lane?.state)).toContain("active"));
    const states = b.published.filter((entry) => entry.key === "u1").map((entry) => entry.event.lane?.state);
    expect(states[0]).toBe("creating");
    expect(states.at(-1)).toBe("active");
  });

  it("starts nothing in the background of a refused create", async () => {
    const b = make();
    await codeOf(b.service.create(b.browser(), b.params({ branch: "main" })));
    expect(b.order).toEqual([]);
  });
});

describe("lanes.create: a failure after the answer", () => {
  it("undoes the worktree when copy throws, fails the lane with prepare, and frees the slot for a second create", async () => {
    const b = make();
    b.behaviour.copy = () => Promise.reject(new Error("copy blew up"));
    const id = await b.create();
    await active(b, id);
    expect(b.view(id)).toMatchObject({ state: "failed", failedReason: "prepare" });
    expect(b.calls.undo).toEqual([join(b.home, "worktrees", id)]);
    expect(b.order).toEqual(["reserve", "create", "copy", "undo"]);
    expect(b.service.paths.roots("u1")).toEqual([]);
    b.behaviour.copy = () => Promise.resolve({ skipped: 0 });
    const second = await b.create({ title: "Second" });
    await active(b, second);
    expect(b.view(second).state).toBe("active");
  });

  it("fails a copy that outlives its deadline with prepare, aborts it and undoes the worktree", async () => {
    const b = make();
    let aborted = false;
    b.behaviour.copy = (signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      });
    const id = await b.create();
    await vi.waitFor(() => expect(b.order).toContain("copy"), { timeout: 5000 });
    await b.clock.advance(PREPARE_DEADLINE_MS - 1);
    expect(b.view(id).state).toBe("creating");
    expect(aborted).toBe(false);
    await b.clock.advance(1);
    await active(b, id);
    expect(aborted).toBe(true);
    expect(b.view(id)).toMatchObject({ state: "failed", failedReason: "prepare" });
    expect(b.calls.undo).toEqual([join(b.home, "worktrees", id)]);
    expect(b.order).not.toContain("ready");
  });

  it.each(["git", "disk"] as const)(
    "fails the lane with %s when the worktree module says so, with no second undo",
    async (step) => {
      const b = make();
      b.behaviour.worktreeCreate = () => Promise.reject(new b.WorktreeFailure(step));
      const id = await b.create();
      await active(b, id);
      expect(b.view(id)).toMatchObject({ state: "failed", failedReason: step });
      expect(b.calls.undo).toEqual([]);
      expect(b.order).toEqual(["reserve", "create"]);
    },
  );

  it("logs and fails with prepare an error the worktree module did not type", async () => {
    const b = make();
    b.behaviour.worktreeCreate = () => Promise.reject(new Error("odd"));
    const id = await b.create();
    await active(b, id);
    expect(b.view(id)).toMatchObject({ state: "failed", failedReason: "prepare" });
    expect(b.calls.undo).toHaveLength(1);
  });

  it("counts what copy skipped in a copy_skipped notice, numbers only", async () => {
    const b = make();
    b.behaviour.copy = () => Promise.resolve({ skipped: 3 });
    const id = await b.create();
    await active(b, id);
    expect(b.view(id).notices).toEqual([{ kind: "copy_skipped", at: b.clock.now(), count: 3 }]);
  });

  it("writes the copy log lines into the setup log", async () => {
    const b = make();
    b.behaviour.copy = () => Promise.resolve({ skipped: 1 });
    b.behaviour.copyLog = ['skipped copy ".env": missing'];
    const id = await b.create();
    await active(b, id);
    expect(b.runner.readLog("u1", id, "setup", 0).text).toContain('skipped copy ".env": missing');
  });
});

describe("shutdown (MC3 carry)", () => {
  it("waits for a create whose worktree add is still running, and starts no session after it", async () => {
    const b = make();
    const gate = deferred();
    b.behaviour.worktreeCreate = () => gate.promise;
    const id = await b.create();
    let stopped = false;
    const stopping = b.service.shutdown().then(() => (stopped = true));
    await vi.waitFor(() => expect(b.order).toContain("create"), { timeout: 5000 });
    await Promise.resolve();
    expect(stopped).toBe(false);
    gate.resolve();
    await stopping;
    expect(b.order).not.toContain("session");
    expect(b.view(id).state).not.toBe("creating");
  });

  it("refuses a create once stopped", async () => {
    const b = make();
    await b.service.shutdown();
    expect(await codeOf(b.service.create(b.browser(), b.params()))).toBe("capacity");
  });

  it("refuses a create caught in phase 1 by a stop: no rows, no worktree add", async () => {
    const gate = deferred();
    let held = false;
    const b = make({
      git: (real) => ({
        run: async (root, args, opts) => {
          if (args[0] === "check-ref-format" && !held) {
            held = true;
            await gate.promise;
          }
          return real.run(root, args, opts);
        },
      }),
    });
    const pending = codeOf(b.service.create(b.browser(), b.params()));
    await vi.waitFor(() => expect(held).toBe(true), { timeout: 5000 });
    const stopping = b.service.shutdown();
    gate.resolve();
    expect(await pending).toBe("capacity");
    await stopping;
    expect(lanes(b)).toEqual([]);
    expect(b.order).toEqual([]);
  });
});
