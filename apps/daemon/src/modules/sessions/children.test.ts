import { type Caller, type ChildSummary, type Dialog, PapError } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { type BedOptions, createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const build = (options?: BedOptions) =>
  createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, options);
let bed: ReturnType<typeof build>;
afterEach(() => bed?.dispose());

const TOKEN: Caller = { ...OWNER, kind: "token", credentialId: "tok1" };
const KEY = "a".repeat(64);
const model = { provider: "faux", id: "plain", name: "Plain", reasoning: false };
const ask = (id: string, message = "bash: npm test") => ({
  type: "approval_request" as const,
  id,
  category: "exec" as const,
  title: "Run?",
  message,
  answers: ["deny", "session", "always", "once"] as Array<"deny" | "session" | "always" | "once">,
  tool: "bash",
  key: KEY,
  tainted: false,
});
const summary = (id: string, extra: Partial<ChildSummary> = {}): ChildSummary => ({
  id,
  runId: `run-${id}`,
  title: `Task of ${id}`,
  profile: null,
  state: "running",
  costUsd: 0.5,
  ...extra,
});

/** A parent with `count` children, the source answering what the subagents module would: newest first. */
async function family(count = 1, options?: BedOptions) {
  bed = build({ limits: { maxWorkers: 20, minFreeMemMb: 0 }, replies: { set_model: {} }, ...options });
  const parent = await bed.service.create(bed.work, OWNER);
  bed.spawned[0]?.emitRaw({
    type: "loadout",
    loadout: {
      model,
      thinkingLevel: "off",
      levels: ["off"],
      preset: "configured",
      tools: ["read"],
      toolsTruncated: false,
    },
  });
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1)
    ids.push(
      (await bed.service.child.createChildSession({ ownerId: "u1", parentSessionId: parent.sessionId }))
        .sessionId,
    );
  const rows = ids.map((id) => summary(id)).toReversed();
  const childrenOf = vi.fn((_owner: string, _parent: string, limit: number) => rows.slice(0, limit));
  bed.service.child.setSource({ childrenOf });
  return { parent: parent.sessionId, ids, childrenOf, rows };
}
const subagentsEvents = (frames: Array<{ event: unknown }>) =>
  frames
    .map((frame) => frame.event as { kind: string; children?: Array<{ id: string; dialogs: Dialog[] }> })
    .filter((event) => event.kind === "subagents");
const lastChildren = (frames: Array<{ event: unknown }>) => subagentsEvents(frames).at(-1)?.children ?? [];

describe("a child's approval in the parent's session (M11R140)", () => {
  it("appears on the parent's stream with the child's own session id, as the child's stream would show it", async () => {
    const { parent, ids } = await family();
    const frames = await bed.subscribe(parent);
    bed.spawned[1]?.emit(ask("d1"));
    await bed.clock.advance(0);
    const [view] = lastChildren(frames);
    expect(view).toMatchObject({ id: ids[0], title: `Task of ${ids[0]}`, state: "running", costUsd: 0.5 });
    expect(view?.dialogs).toEqual([
      expect.objectContaining({ id: "d1", method: "approval", tool: "bash", message: "bash: npm test" }),
    ]);
    // The child's own stream shows the same card.
    const own = await bed.snapshot(ids[0] ?? "");
    expect((own as { dialogs: Dialog[] }).dialogs).toEqual(view?.dialogs);
  });

  it("is in the parent's snapshot, newest children first", async () => {
    const { parent, ids } = await family(2);
    bed.spawned[2]?.emit(ask("d2"));
    await bed.clock.advance(0);
    const snapshot = (await bed.snapshot(parent)) as { children: Array<{ id: string; dialogs: Dialog[] }> };
    expect(snapshot.children.map((child) => child.id)).toEqual([ids[1], ids[0]]);
    expect(snapshot.children[0]?.dialogs.map((dialog) => dialog.id)).toEqual(["d2"]);
    expect(snapshot.children[1]?.dialogs).toEqual([]);
  });

  it("answered with the child's id, closes on the child, on the parent's stream and in the snapshot", async () => {
    const { parent, ids } = await family();
    const frames = await bed.subscribe(parent);
    bed.spawned[1]?.emit(ask("d1"));
    await bed.clock.advance(0);
    bed.service.respondDialog(
      { sessionId: ids[0] ?? "", dialogId: "d1", response: { answer: "once" } },
      OWNER,
    );
    await bed.clock.advance(0);
    expect(bed.spawned[1]?.sent.filter((record) => record.type === "approval_response")).toMatchObject([
      { id: "d1", answer: "once" },
    ]);
    expect(lastChildren(frames)[0]?.dialogs).toEqual([]);
    const snapshot = (await bed.snapshot(parent)) as { children: Array<{ dialogs: Dialog[] }> };
    expect(snapshot.children[0]?.dialogs).toEqual([]);
  });

  it("is answered through the child's own permissions: another owner cannot, a token cannot answer always", async () => {
    const { ids } = await family();
    bed.spawned[1]?.emit(ask("d1"));
    await bed.clock.advance(0);
    const answer = (caller: Caller, response: object) => () =>
      bed.service.respondDialog({ sessionId: ids[0] ?? "", dialogId: "d1", response } as never, caller);
    expect(answer({ ...OWNER, userId: "u2" }, { answer: "once" })).toThrow(new PapError("not_found"));
    for (const choice of ["always", "session"])
      expect(answer(TOKEN, { answer: choice })).toThrow(new PapError("forbidden"));
    expect(bed.spawned[1]?.sent.filter((record) => record.type === "approval_response")).toEqual([]);
    answer(TOKEN, { answer: "once" })();
    expect(bed.spawned[1]?.sent.filter((record) => record.type === "approval_response")).toHaveLength(1);
  });

  it("carries an input dialog too", async () => {
    const { parent } = await family();
    const frames = await bed.subscribe(parent);
    bed.spawned[1]?.emit({ type: "extension_ui_request", id: "i1", method: "input", title: "Name?" });
    await bed.clock.advance(0);
    expect(lastChildren(frames)[0]?.dialogs).toEqual([
      expect.objectContaining({ id: "i1", method: "input" }),
    ]);
  });

  it("says nothing on the parent's stream for a session that is not a child", async () => {
    const { parent } = await family();
    const frames = await bed.subscribe(parent);
    const other = await bed.service.create(bed.work, OWNER);
    bed.spawned[2]?.emit(ask("x1"));
    await bed.clock.advance(0);
    expect(other.sessionId).not.toBe(parent);
    expect(subagentsEvents(frames)).toEqual([]);
  });

  it("is told again when the subagents module says a child changed", async () => {
    const { parent, rows } = await family();
    const frames = await bed.subscribe(parent);
    rows[0] = summary(rows[0]?.id ?? "", { state: "done", costUsd: 1.25 });
    bed.service.child.refresh(parent);
    expect(lastChildren(frames)[0]).toMatchObject({ state: "done", costUsd: 1.25 });
  });
});

describe("the children in a snapshot are at most eight, the newest (M11R140)", () => {
  it("asks the source for eight and keeps nine children's newest eight", async () => {
    const { parent, ids, childrenOf } = await family(9);
    const snapshot = (await bed.snapshot(parent)) as { children: Array<{ id: string }> };
    expect(childrenOf).toHaveBeenCalledWith("u1", parent, 8);
    expect(snapshot.children.map((child) => child.id)).toEqual(ids.slice(1).toReversed());
  });

  it("keeps eight even when the source answers more", async () => {
    const { parent, rows } = await family(1);
    bed.service.child.setSource({
      childrenOf: () => Array.from({ length: 12 }, (_, index) => summary(`${rows[0]?.id}-${index}`)),
    });
    const snapshot = (await bed.snapshot(parent)) as { children: unknown[] };
    expect(snapshot.children).toHaveLength(8);
  });

  it("is empty without a source or for a session with no children", async () => {
    bed = build();
    const parent = await bed.service.create(bed.work, OWNER);
    expect(((await bed.snapshot(parent.sessionId)) as { children: unknown[] }).children).toEqual([]);
  });
});

describe("a waiting child makes its parent need input (M10's attention, M11R140)", () => {
  const parentNeeds = (parent: string): boolean | undefined => {
    const event = bed.service.shellSnapshot("u1") as {
      sessions?: Array<{ id: string; needsInput: boolean }>;
    };
    return event.sessions?.find((session) => session.id === parent)?.needsInput;
  };

  it("is true while one child waits, false once it was answered, and the attention feed hears both", async () => {
    const { parent, ids } = await family(2);
    const heard: Array<[string, boolean]> = [];
    bed.service.automation.onAttention((sessionId, needsInput) => void heard.push([sessionId, needsInput]));
    expect(parentNeeds(parent)).toBe(false);
    bed.spawned[1]?.emit(ask("d1"));
    bed.spawned[2]?.emit(ask("d2"));
    await bed.clock.advance(1_000);
    expect(parentNeeds(parent)).toBe(true);
    expect(bed.service.child.waiting(parent)).toBe(true);
    expect(heard).toContainEqual([parent, true]);
    bed.service.respondDialog(
      { sessionId: ids[0] ?? "", dialogId: "d1", response: { answer: "once" } },
      OWNER,
    );
    await bed.clock.advance(1_000);
    expect(parentNeeds(parent)).toBe(true);
    bed.service.respondDialog(
      { sessionId: ids[1] ?? "", dialogId: "d2", response: { answer: "once" } },
      OWNER,
    );
    await bed.clock.advance(1_000);
    expect(parentNeeds(parent)).toBe(false);
    expect(bed.service.child.waiting(parent)).toBe(false);
    expect(heard.filter(([sessionId]) => sessionId === parent).at(-1)).toEqual([parent, false]);
  });

  it("says which agent has a child waiting, for that owner only", async () => {
    const { ids } = await family();
    bed.spawned[1]?.emit(ask("d1"));
    await bed.clock.advance(0);
    expect(bed.service.child.waitingAgent("u1", "atlas-1a2b")).toBe(false);
    bed.db.run("UPDATE sessions SET agent_id = 'atlas-1a2b', agent_role = 'child' WHERE id = $id", {
      id: ids[0] ?? "",
    });
    expect(bed.service.child.waitingAgent("u1", "atlas-1a2b")).toBe(true);
    expect(bed.service.child.waitingAgent("u2", "atlas-1a2b")).toBe(false);
    expect(bed.service.child.waitingAgent("u1", "nova-1a2b")).toBe(false);
  });
});
