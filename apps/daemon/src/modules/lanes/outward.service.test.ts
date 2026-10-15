import { ORIGIN_URLS_ARGS, PUSH_SCAN_ARGS } from "../../kernel/git/exec.ts";
import type { Forge } from "../../kernel/forge/port.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CreateBed, createCreateBed, deferred } from "./testing/create-bed.ts";

const GH = "https://github.com/o/r.git\n";
const same = (a: readonly string[], b: readonly string[]) => a.join("\0") === b.join("\0");
let bed: CreateBed | undefined;
afterEach(async () => {
  await bed?.service.shutdown();
  bed?.dispose();
  bed = undefined;
});

/** The lane git calls answer here (the fake git dir cannot run real ones); a push waits for `gate`. */
function make(gate?: Promise<void>) {
  const audit: unknown[] = [];
  const pushes: string[] = [];
  const forgeCalls: string[] = [];
  const forge: Forge = {
    kind: "github",
    findPr: async () => (forgeCalls.push("find"), { ok: true, value: null }),
    createPr: async () => (
      forgeCalls.push("create"),
      {
        ok: true,
        value: {
          number: 7,
          url: "https://github.com/o/r/pull/7",
          state: "open",
          draft: false,
          conflicts: null,
          checks: null,
          checkedAt: 1,
          error: null,
        },
      }
    ),
    viewPr: async (_repo, number) => ({
      ok: true,
      value: {
        number,
        url: "https://github.com/o/r/pull/7",
        state: "open",
        draft: false,
        conflicts: false,
        checks: null,
        checkedAt: 2,
        error: null,
      },
    }),
    viewIssue: async () => {
      throw new Error("unused");
    },
  };
  const b = (bed = createCreateBed({
    git: (real) => ({
      async run(root, args, opts) {
        if (same(args, PUSH_SCAN_ARGS)) return { stdout: Buffer.alloc(0), code: 0 };
        if (same(args, ORIGIN_URLS_ARGS)) return { stdout: Buffer.from(GH), code: 0 };
        if (args[0] === "remote") return { stdout: Buffer.from(GH), code: 0 };
        if (args[0] === "push") {
          pushes.push(args.join(" "));
          await gate;
          return { stdout: Buffer.alloc(0), code: 0, stderr: "" };
        }
        if (args[0] === "status")
          return {
            stdout: Buffer.from("# branch.oid a\0# branch.upstream origin/x\0# branch.ab +1 -0\0"),
            code: 0,
          };
        if (args[0] === "merge-base") return { stdout: Buffer.from("mb\n"), code: 0 };
        if (args[0] === "rev-list") return { stdout: Buffer.from("0\n"), code: 0 };
        if (args[0] === "diff") return { stdout: Buffer.from(""), code: 0 };
        return real.run(root, args, opts);
      },
    }),
    deps: {
      audit: { append: (line) => void audit.push(line) },
      forgeFor: (kind) => (kind === "github" ? forge : null),
    },
  }));
  return { b, audit, pushes, forgeCalls };
}
async function activeLane(b: CreateBed): Promise<string> {
  const id = await b.create();
  await vi.waitFor(() => expect(b.view(id).state).toBe("active"), { timeout: 5000 });
  await vi.waitFor(() => expect(b.view(id).setup.state).not.toMatch(/queued|running/), { timeout: 5000 });
  return id;
}

describe("the lane service's outward operations", () => {
  it("pushes the lane's branch, writes the audit row and shows the remote in the lane's view", async () => {
    const { b, audit, pushes } = make();
    const id = await activeLane(b);
    const branch = b.view(id).branch;
    expect(await b.service.push(b.browser(), { laneId: id })).toEqual({
      ok: true,
      remote: { host: "github.com", path: "o/r" },
    });
    expect(pushes).toEqual([
      `push --porcelain --set-upstream origin refs/heads/${branch}:refs/heads/${branch}`,
    ]);
    expect(audit).toEqual([
      expect.objectContaining({
        reason: "lane_pushed",
        detail: { laneId: id, host: "github.com", path: "o/r" },
      }),
    ]);
    await vi.waitFor(() =>
      expect(b.view(id)).toMatchObject({
        forge: "github",
        remote: { host: "github.com", path: "o/r" },
        pushRemote: { host: "github.com", path: "o/r" },
      }),
    );
  });

  it("does not hold the lane lock during a push: a capture runs meanwhile, and a second push waits", async () => {
    const gate = deferred();
    const { b, pushes } = make(gate.promise);
    const id = await activeLane(b);
    const first = b.service.push(b.browser(), { laneId: id });
    const second = b.service.push(b.browser(), { laneId: id });
    await vi.waitFor(() => expect(pushes).toHaveLength(1), { timeout: 5000 });
    let captured = false;
    await b.service.laneLock(id).run("checkpoint", async () => void (captured = true));
    expect(captured).toBe(true);
    expect(pushes).toHaveLength(1);
    gate.resolve();
    await Promise.all([first, second]);
    expect(pushes).toHaveLength(2);
  });

  it("creates a pull request, stores it on the lane and shows it in the view; a second call reuses the stored one", async () => {
    const { b, forgeCalls } = make();
    const id = await activeLane(b);
    await b.service.refresh(b.browser(), id);
    const made = await b.service.prCreate(b.browser(), { laneId: id, title: "T", body: "B", draft: false });
    expect(made).toMatchObject({ ok: true, pr: { number: 7, conflicts: false } });
    expect(forgeCalls).toEqual(["find", "create"]);
    expect(b.view(id).pr).toMatchObject({ number: 7, url: "https://github.com/o/r/pull/7" });
    const row = b.db.get<{ pr_number: number; pr_url: string }>(
      "SELECT pr_number, pr_url FROM lanes WHERE id = $id",
      { id },
    );
    expect(row).toEqual({ pr_number: 7, pr_url: "https://github.com/o/r/pull/7" });
  });
});
