import { realpathSync } from "node:fs";
import { PapError } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { fakePolicyPort } from "./testing/fake-policy.ts";
import { codeOf } from "./testing/helpers.ts";
import { type BedOptions, createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const build = (options: BedOptions = {}) =>
  createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, options);
let bed: ReturnType<typeof build>;
afterEach(() => bed.dispose());

const TWO: ReadonlyArray<readonly [string, string]> = [
  ["q0", "r0"],
  ["q1", "r1"],
];

/** A session whose worker was told to stop and has not exited yet (the fake worker waits for `exitFirst`). */
async function releasing(options: BedOptions = {}) {
  bed = build({
    idleMs: 1000,
    holdShutdown: true,
    start: () => ({ kind: "ready", leafId: "a1" }),
    ...options,
  });
  const { sessionId } = await bed.service.create(bed.work, OWNER);
  const file = bed.writePiFile(0, TWO);
  bed.store.bindPiFile(sessionId, file, "pi-0");
  await bed.clock.advance(1000);
  expect(bed.service.list(OWNER)[0]?.status).toBe("releasing");
  return { sessionId, file };
}
const exitFirst = () => bed.spawned[0]?.crash({ code: 0, signal: null, cause: "clean" });
const requestTypes = (index: number) => bed.spawned[index]?.requests.map((request) => request.type);

describe("a prompt while a worker is released (Review Focus 5)", () => {
  it("waits for the exit and reopens on the same file", async () => {
    const { sessionId } = await releasing();
    const prompted = bed.service.prompt({ sessionId, text: "again" }, OWNER);
    await bed.clock.advance(0);
    expect(requestTypes(0)).toEqual([]);
    exitFirst();
    expect(await prompted).toEqual({ disposition: "started" });
    expect(bed.spawned).toHaveLength(2);
    expect(bed.spawned[1]?.sent[0]).toMatchObject({ type: "init", sessionFile: bed.files[0] });
    expect(requestTypes(0)).toEqual([]);
    expect(requestTypes(1)).toEqual(["prompt"]);
  });

  it("starts one worker for two prompts that arrive together", async () => {
    const { sessionId } = await releasing();
    const first = bed.service.prompt({ sessionId, text: "a" }, OWNER);
    const second = bed.service.prompt({ sessionId, text: "b" }, OWNER);
    await bed.clock.advance(0);
    exitFirst();
    await Promise.all([first, second]);
    expect(bed.spawned).toHaveLength(2);
    expect(requestTypes(1)).toEqual(["prompt", "prompt"]);
  });

  it("shows releasing, then cold, then the new worker's starting", async () => {
    const { sessionId } = await releasing();
    const frames = await bed.subscribe(sessionId);
    const prompted = bed.service.prompt({ sessionId, text: "again" }, OWNER);
    await bed.clock.advance(0);
    exitFirst();
    await prompted;
    const statuses = frames.flatMap(({ event }) =>
      (event as { kind: string }).kind === "status" ? [(event as { status: string }).status] : [],
    );
    expect(statuses).toEqual(["cold", "starting", "idle"]);
    expect(bed.service.list(OWNER)[0]?.status).toBe("idle");
  });

  it("is refused with capacity, starting nothing, when the daemon is shutting down meanwhile", async () => {
    const { sessionId } = await releasing();
    const prompted = bed.service.prompt({ sessionId, text: "late" }, OWNER);
    const caught = codeOf(prompted);
    await bed.clock.advance(0);
    const closed = bed.service.shutdownAll();
    exitFirst();
    await closed;
    expect(await caught).toBe("capacity");
    expect(bed.spawned).toHaveLength(1);
  });
});

describe("a daemon that closes", () => {
  it("shows cold with no cause for a worker it stopped, as for a released one (M2R111)", async () => {
    bed = build();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    const frames = await bed.subscribe(sessionId);
    await bed.service.shutdownAll();
    const statuses = frames.flatMap(({ event }) =>
      (event as { kind: string }).kind === "status" ? [event] : [],
    );
    expect(statuses).toEqual([{ kind: "status", status: "cold" }]);
  });
});

describe("Stop and the queue while a worker is released (M2R112, M2-RT-39)", () => {
  it("answers Stop at once", async () => {
    const { sessionId } = await releasing();
    expect(await bed.service.clearQueue(sessionId, OWNER)).toEqual({
      steering: [],
      followUp: [],
      truncated: false,
    });
    await bed.service.abort(sessionId, OWNER);
    expect(requestTypes(0)).toEqual([]);
  });

  it("asks a worker that is up, as before", async () => {
    bed = build({ idleMs: 1000 });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    expect(await bed.service.clearQueue(sessionId, OWNER)).toEqual({
      steering: ["left"],
      followUp: ["after"],
      truncated: false,
    });
    expect(requestTypes(0)).toEqual(["clear_queue"]);
  });
});

describe("what else a released session is asked", () => {
  it("answers a dialog or a panel input for a closing worker as not_found, sending it nothing", async () => {
    const { sessionId } = await releasing();
    // What an extension's shutdown handler may still open while the worker closes.
    bed.spawned[0]?.emit({
      type: "extension_ui_request",
      id: "d1",
      method: "confirm",
      title: "t",
      message: "m",
    });
    bed.spawned[0]?.emit({ type: "custom_render", id: "p1", lines: ["x"] });
    const sent = bed.spawned[0]?.sent.length;
    expect(() =>
      bed.service.respondDialog({ sessionId, dialogId: "d1", response: { confirmed: true } }, OWNER),
    ).toThrow(new PapError("not_found"));
    expect(() => bed.service.panelInput({ sessionId, panelId: "p1", data: "q" }, OWNER)).toThrow(
      new PapError("not_found"),
    );
    expect(bed.spawned[0]?.sent).toHaveLength(sent ?? -1);
  });

  it.each([
    [
      "navigate",
      (id: string) => bed.service.navigate({ sessionId: id, targetId: "u0" }, OWNER),
      "navigate_tree",
    ],
    ["compact", (id: string) => bed.service.compact({ sessionId: id }, OWNER), "compact"],
    ["rename", (id: string) => bed.service.rename({ sessionId: id, name: "New" }, OWNER), "set_session_name"],
    ["autoName", (id: string) => bed.service.autoName(id, OWNER), "auto_name"],
  ] as const)(
    "%s waits for the exit and goes to the new worker, never the closing one",
    async (_n, act, type) => {
      const { sessionId } = await releasing({
        replies: { set_session_name: {}, auto_name: { data: { title: "Title" } } },
      });
      const done = act(sessionId);
      await bed.clock.advance(0);
      expect(requestTypes(0)).toEqual([]);
      exitFirst();
      await done;
      expect(bed.spawned).toHaveLength(2);
      expect(requestTypes(0)).toEqual([]);
      expect(requestTypes(1)).toContain(type);
    },
  );

  it("exports through the new worker", async () => {
    const { sessionId } = await releasing({ replies: { export_html: "held" } });
    const done = codeOf(bed.service.exportHtml(sessionId, OWNER));
    await bed.clock.advance(0);
    expect(requestTypes(0)).toEqual([]);
    exitFirst();
    await bed.clock.advance(0);
    await bed.clock.advance(0);
    expect(requestTypes(1)).toEqual(["export_html"]);
    bed.answerHeld(1, "export_html", { success: false, error: "refused" });
    expect(await done).toBe("command_failed");
    expect(requestTypes(0)).toEqual([]);
  });

  it("forks and clones from the file, with no worker asked and none started", async () => {
    const { sessionId } = await releasing();
    const forked = await bed.service.fork({ sessionId, entryId: "u1" }, OWNER);
    expect(forked.text).toBe("q1");
    const cloned = await bed.service.clone({ sessionId }, OWNER);
    expect(
      bed.service
        .list(OWNER)
        .filter((s) => s.id !== sessionId)
        .map((s) => s.status),
    ).toEqual(["cold", "cold"]);
    expect(cloned.sessionId).not.toBe(forked.sessionId);
    expect(bed.spawned).toHaveLength(1);
    expect(requestTypes(0)).toEqual([]);
  });

  it("reads the session while it is released", async () => {
    const { sessionId } = await releasing();
    const frames = await bed.subscribe(sessionId);
    expect((frames[0]?.event as { kind: string }).kind).toBe("snapshot");
    expect(await bed.service.branches(sessionId, OWNER)).toEqual({
      leafId: "a1",
      points: [],
      truncated: false,
    });
    expect(requestTypes(0)).toEqual([]);
  });
});

describe("rules pushed to a released worker (Task 14b)", () => {
  it("send nothing to the closing worker; the next one starts with them", async () => {
    const policy = fakePolicyPort();
    const { sessionId } = await releasing({ policy });
    const before = bed.spawned[0]?.sent.length;
    policy.addAlways({
      ownerId: OWNER.userId,
      scope: realpathSync(bed.work),
      tool: "bash",
      key: "a".repeat(64),
      label: "x",
    });
    await bed.clock.advance(0);
    expect(bed.spawned[0]?.sent).toHaveLength(before ?? -1);
    expect(bed.spawned[0]?.stopped()).toBe(true);
    const prompted = bed.service.prompt({ sessionId, text: "again" }, OWNER);
    await bed.clock.advance(0);
    exitFirst();
    await prompted;
    expect(bed.spawned[1]?.sent[0]).toMatchObject({
      type: "init",
      policy: { alwaysAllow: [{ tool: "bash", key: "a".repeat(64) }] },
    });
    expect(bed.spawned[1]?.sent.filter((r) => r.type === "policy_update")).toEqual([]);
  });
});

describe("what keeps a worker from being released", () => {
  it.each([
    [
      "navigate",
      (id: string) => bed.service.navigate({ sessionId: id, targetId: "u0" }, OWNER),
      "navigate_tree",
    ],
    ["compact", (id: string) => bed.service.compact({ sessionId: id }, OWNER), "compact"],
  ] as const)("a %s in flight", async (_n, act, type) => {
    bed = build({ idleMs: 1000, replies: { [type]: "held" } });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    void codeOf(act(sessionId));
    await bed.clock.advance(5000);
    expect(bed.service.list(OWNER)[0]?.status).toBe("idle");
    expect(bed.spawned[0]?.stopped()).toBe(false);
    bed.answerHeld(0, type, { data: { cancelled: false, leafId: null } });
    await bed.clock.advance(1000);
    expect(bed.spawned[0]?.stopped()).toBe(true);
  });

  it("a worker that exits on its own is not asked to stop, and a later prompt reopens it", async () => {
    bed = build({ idleMs: 1000 });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    bed.spawned[0]?.crash({ code: 1, signal: null, cause: "exit_code" });
    await bed.clock.advance(5000);
    expect(bed.spawned[0]?.sent.filter((r) => r.type === "shutdown")).toEqual([]);
    await bed.service.prompt({ sessionId, text: "x" }, OWNER);
    expect(bed.spawned).toHaveLength(2);
  });
});
