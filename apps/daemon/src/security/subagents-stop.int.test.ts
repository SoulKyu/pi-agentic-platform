import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startTestDaemon, type TestDaemon } from "../testing/harness.ts";
import type { TestClient } from "../testing/ws-client.ts";
import { openOwner, type Owner, result, rows } from "./testing/automation-bed.ts";
import { lookupTool, markOf, waitIdle } from "./testing/fixtures.ts";

// M11R139 to M11R141 in a whole daemon, on the scripted provider:
//   1. a parent starts two children whose scripts wait on an approval; the owner's Stop on the parent aborts both, closes
//      their cards, leaves no worker for them, and the held tool calls end `cancelled`;
//   2. a second parent's children wait the same way; the owner answers one from the PARENT's stream with the child's id,
//      that child continues and its answer returns, the other waits until it is answered too;
//   3. the children's runs carry the parent's id and their scripted price, and the parent's stream shows each child's cost.
// A worker takes its script from its first step when it starts: a phase writes the script of the worker that starts next.

const CHILD_TEXT = "CHILD-ANSWER-91c2";
const call2 = (id: string, task: string) => ({ name: "subagent", args: { task }, id });

let t: TestDaemon;
let owner: Owner;
let client: TestClient;
const scriptOf = (steps: object[]) => ({ steps, prices: { input: 1000, output: 1000 } });
const writeScript = (steps: object[]): void =>
  writeFileSync(join(t.root, "script.json"), JSON.stringify(scriptOf(steps)));

beforeAll(async () => {
  t = await startTestDaemon(scriptOf([{ text: "unused" }]), {
    extensions: { lookup: lookupTool("a page") },
    config: { maxWorkers: 12 },
  });
  owner = await openOwner(t);
  client = owner.client;
});
afterAll(async () => {
  client.close();
  await t.stop();
});

const call = async <T>(method: string, params: object): Promise<T> =>
  result<T>(await client.call(method as never, params as never));
const runsOf = (parentId: string) =>
  rows<{ state: string; reason: string | null; child_session_id: string | null }>(
    t.home,
    "SELECT state, reason, child_session_id FROM subagent_runs WHERE parent_session_id = ? ORDER BY started_at, id",
    parentId,
  );
interface Shown {
  id: string;
  state: string;
  costUsd: number;
  dialogs: Array<{ id: string; method: string }>;
}
/** The children as the parent's stream last showed them: the snapshot's, then each `subagents` event. */
const shown = (): Shown[] => {
  let children: Shown[] = [];
  for (const frame of client.events) {
    const event = frame.event as { kind?: string; children?: Shown[] };
    if (event.kind === "snapshot" || event.kind === "subagents") children = event.children ?? children;
  }
  return children;
};
const parentWithTwoChildren = async (): Promise<{ parent: string; mark: number }> => {
  client.close();
  client = await t.connect(owner.cookie);
  writeScript([
    { toolCalls: [call2("sa1", "First look"), call2("sa2", "Second look")] },
    { text: "Parent done." },
  ]);
  const parent = (await call<{ sessionId: string }>("sessions.create", { cwd: t.cwd })).sessionId;
  // The parent's worker has read its script (its session is up); the next two workers are the children's.
  writeScript([{ toolCalls: [{ name: "lookup", args: { q: "x" }, id: "l1" }] }, { text: CHILD_TEXT }]);
  await vi.waitFor(
    async () => {
      const { sessions } = await call<{ sessions: Array<{ id: string; status: string }> }>(
        "sessions.list",
        {},
      );
      expect(sessions.find((session) => session.id === parent)?.status).toBe("idle");
    },
    { timeout: 20_000 },
  );
  await call("subscribe.session", { sessionId: parent });
  const mark = markOf(client);
  await call("sessions.prompt", { sessionId: parent, text: "Delegate two looks." });
  // Both cards are open, each on its own child, and the parent's stream carries them.
  await vi.waitFor(
    () => {
      const children = shown();
      expect(children).toHaveLength(2);
      for (const child of children) expect(child.dialogs).toHaveLength(1);
    },
    { timeout: 30_000 },
  );
  return { parent, mark };
};

describe("subagents: Stop, approvals in the parent, roll-up (Task 30)", () => {
  it("the owner's Stop on the parent aborts both children, closes their cards and leaves no worker for them", async () => {
    const { parent } = await parentWithTwoChildren();
    const children = shown();
    expect(children.every((child) => child.dialogs[0]?.method === "approval")).toBe(true);
    const ids = children.map((child) => child.id);
    for (const id of ids) expect(t.daemon.inspect.workerPid(id)).toBeGreaterThan(1);

    await call("sessions.abort", { sessionId: parent });

    await vi.waitFor(
      () =>
        expect(runsOf(parent).map((run) => [run.state, run.reason])).toEqual([
          ["cancelled", "stopped"],
          ["cancelled", "stopped"],
        ]),
      { timeout: 30_000 },
    );
    await vi.waitFor(
      () => {
        const after = shown();
        expect(after.map((child) => child.dialogs)).toEqual([[], []]);
        expect(after.map((child) => child.state)).toEqual(["cancelled", "cancelled"]);
      },
      { timeout: 30_000 },
    );
    await vi.waitFor(
      () => {
        for (const id of ids) expect(t.daemon.inspect.workerPid(id)).toBeUndefined();
      },
      { timeout: 30_000 },
    );
    // The held calls ended `cancelled`: each tool result says so.
    for (const toolCallId of ["sa1", "sa2"])
      await vi.waitFor(
        async () => {
          const output = await call<{ text: string; isError: boolean }>("sessions.toolOutput", {
            sessionId: parent,
            toolCallId,
          });
          expect(output).toMatchObject({ text: "subagent was cancelled.", isError: true });
        },
        { timeout: 30_000 },
      );
    for (const id of ids)
      expect(
        rows<{ status: string }>(t.home, "SELECT status FROM runs WHERE session_id = ?", id)[0]?.status,
      ).toBe("cancelled");
  });

  it("an approval answered from the parent's stream, with the child's id, lets that child continue and its answer return", async () => {
    const { parent, mark } = await parentWithTwoChildren();
    const [first, second] = shown();
    expect(first?.dialogs[0]?.id).toBeDefined();
    await call("sessions.respondDialog", {
      sessionId: first?.id,
      dialogId: first?.dialogs[0]?.id,
      response: { answer: "once" },
    });
    await vi.waitFor(
      () => {
        const now = shown();
        expect(now.find((child) => child.id === first?.id)).toMatchObject({ state: "done", dialogs: [] });
        expect(now.find((child) => child.id === second?.id)?.dialogs).toHaveLength(1);
      },
      { timeout: 30_000 },
    );
    expect(
      runsOf(parent)
        .map((run) => run.state)
        .toSorted(),
    ).toEqual(["done", "running"]);
    await call("sessions.respondDialog", {
      sessionId: second?.id,
      dialogId: second?.dialogs[0]?.id,
      response: { answer: "once" },
    });
    await waitIdle(client, mark);

    for (const id of ["sa1", "sa2"]) {
      const output = await call<{ text: string }>("sessions.toolOutput", {
        sessionId: parent,
        toolCallId: id,
      });
      expect(output.text).toContain(CHILD_TEXT);
    }
    expect(runsOf(parent).map((run) => run.state)).toEqual(["done", "done"]);
  });

  it("rolls the children's runs and their price up to the parent: the column, the registry's cost and the cost each child shows", async () => {
    const { parent, mark } = await parentWithTwoChildren();
    for (const child of shown())
      await call("sessions.respondDialog", {
        sessionId: child.id,
        dialogId: child.dialogs[0]?.id,
        response: { answer: "once" },
      });
    await waitIdle(client, mark);
    const childRuns = rows<{ session_id: string; cost_usd: number; origin: string }>(
      t.home,
      "SELECT session_id, cost_usd, origin FROM runs WHERE parent_session_id = ? AND status = 'completed'",
      parent,
    );
    expect(childRuns).toHaveLength(2);
    for (const run of childRuns) {
      expect(run.origin).toBe("subagent");
      expect(run.cost_usd).toBeGreaterThan(0);
    }
    const own =
      rows<{ usd: number }>(t.home, "SELECT SUM(cost_usd) AS usd FROM runs WHERE session_id = ?", parent)[0]
        ?.usd ?? 0;
    const children = childRuns.reduce((sum, run) => sum + run.cost_usd, 0);
    // The registry's answer for the parent: its own runs plus both children's.
    expect(t.daemon.inspect.sessionCost(parent)).toBeCloseTo(own + children, 9);
    for (const run of childRuns) expect(t.daemon.inspect.sessionCost(run.session_id)).toBe(run.cost_usd);
    // The parent's screen shows each child's own cost.
    await vi.waitFor(
      () =>
        expect(
          shown()
            .map((child) => child.costUsd)
            .toSorted(),
        ).toEqual(childRuns.map((run) => run.cost_usd).toSorted()),
      { timeout: 30_000 },
    );
  });
});
