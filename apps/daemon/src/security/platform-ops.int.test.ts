import { join } from "node:path";
import {
  AgentInput,
  PLATFORM_OP_NAMES,
  type PlatformOp,
  type SessionType,
  TriggerInput,
} from "@pap/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../kernel/db/database.ts";
import { captureLogger } from "../testing/capture-logger.ts";
import { startOutwardBed, type OutwardBed } from "../modules/lanes/testing/outward-bed.ts";
import { alertBody, bearer, createTrigger, deliver, rows, webhookInput } from "./testing/automation-bed.ts";
import { callOf, effectsOf, opRows, requestRows, taskRowsOf, writeScript } from "./testing/agent-bed.ts";
import { everyOp, rawAnswers, rawCall, rawStep } from "./testing/raw-platform-extension.ts";

// The roadmap's first M11 exit criterion, from inside real workers: "no caller can run an op its session type does not
// allow". One real session of each type sends a raw `platform_call` for every op (what a compromised worker would send:
// most types register no such tool). Exactly the table's cells run; every other cell is `forbidden`, changes nothing and
// leaves one `block` audit row `{op, type, code}`. The `subagent.run` cells of plain, lane and agent-thread run (Task 29b's
// handler; the owner's switch is on by default) and each of those workers registers the `subagent` tool (RT-09: read from its loadout).

type Cell = "ok" | "forbidden";
const NONE: Record<PlatformOp, Cell> = {
  "agent.notify": "forbidden",
  "agent.approve": "forbidden",
  "agent.delegate": "forbidden",
  "agent.remind": "forbidden",
  "lane.note": "forbidden",
  "secret.request": "forbidden",
  "network.request": "forbidden",
  "subagent.run": "forbidden",
};
// The table, written out by hand: the oracle does not read the contract it checks.
const MATRIX: Record<SessionType, Record<PlatformOp, Cell>> = {
  plain: { ...NONE, "subagent.run": "ok" },
  lane: { ...NONE, "lane.note": "ok", "subagent.run": "ok" },
  task: NONE,
  "agent-thread": {
    ...NONE,
    "agent.notify": "ok",
    "agent.approve": "ok",
    "agent.delegate": "ok",
    "agent.remind": "ok",
    "secret.request": "ok",
    "network.request": "ok",
    "subagent.run": "ok",
  },
  "agent-task": NONE,
  child: NONE,
};

const logs = captureLogger();
let bed: OutwardBed;
let call: ReturnType<typeof callOf>;
let atlas: string;
let scout: string;
const resultsFile = (name: string) => join(bed.t.root, `raw-${name}.jsonl`);
/** Writes the script the next worker reads: every op once, its answers in a file of its own. */
const armScript = (name: string, steps: object[] = [rawStep(everyOp())]) =>
  writeScript(bed.t, { steps, captureRawResults: resultsFile(name) });

beforeAll(async () => {
  bed = await startOutwardBed(
    [{}],
    {},
    { steps: [{ text: "x" }], logger: logs.logger, config: { maxWorkers: 12 }, vm: true },
  );
  call = callOf(bed.owner);
  atlas = (await call<{ id: string }>("agents.create", { input: AgentInput.parse({ name: "Atlas" }) })).id;
  scout = (
    await call<{ id: string }>("agents.create", {
      input: AgentInput.parse({ name: "Scout", acceptsDelegation: true }),
    })
  ).id;
});
afterAll(async () => {
  await bed?.stop();
});

/** The tool names the session's worker offers its model, as the stream's loadout says (not the audit rows of calls). */
async function toolsOf(sessionId: string): Promise<string[]> {
  const { sub } = await call<{ sub: string }>("subscribe.session", { sessionId });
  let tools: string[] = [];
  await vi.waitFor(
    () => {
      const loadouts = bed.owner.events
        .filter((frame) => frame.sub === sub)
        .map((frame) => frame.event as { kind?: string; loadout?: { tools: string[] } | null })
        .filter((event) => event.loadout);
      expect(loadouts.length).toBeGreaterThan(0);
      tools = loadouts.at(-1)?.loadout?.tools ?? [];
    },
    { timeout: 30_000 },
  );
  return tools;
}

/** Waits until the daemon wrote its one row per call, answering the thread's cards the way an owner would. */
async function settled(sessionId: string, answer = false): Promise<void> {
  await vi.waitFor(
    async () => {
      if (answer) {
        for (const request of requestRows(bed.t).filter((row) => row.state === "pending")) {
          if (request.kind === "approve")
            await call("agents.answerApproval", { requestId: request.id, approved: true });
          else
            await call("secrets.answerRequest", {
              requestId: request.id,
              value: "pap-test-secret-matrix01",
              mode: "once",
            });
        }
      }
      expect(opRows(bed.t, sessionId)).toHaveLength(PLATFORM_OP_NAMES.length);
    },
    { timeout: 60_000, interval: 100 },
  );
}

/** Each op once, in the cell the table says; a refused call is one `block` row with the op, the type and the code. */
function expectCells(sessionId: string, type: SessionType): void {
  const seen = opRows(bed.t, sessionId);
  expect(seen.map((row) => row.tool).sort()).toEqual([...PLATFORM_OP_NAMES].sort());
  for (const op of PLATFORM_OP_NAMES) {
    const row = seen.find((entry) => entry.tool === op);
    const cell = MATRIX[type][op];
    expect(row, `${type} ${op}`).toMatchObject(
      cell === "ok"
        ? { decision: "allow", reason: "ok", detail: { op, type, code: "ok" } }
        : { decision: "block", reason: cell, detail: { op, type, code: cell } },
    );
  }
}

/**
 * What the worker itself heard back, for the types whose worker is still up when the answers arrive. A session whose
 * `subagent.run` runs also starts a child worker that reads the same script: its eight raw calls are all forbidden (type
 * `child`) and are answered into the same file, so each id is expected twice, once from the parent and once from the child.
 */
async function expectAnswers(name: string, type: SessionType, childScripted = true): Promise<void> {
  const answer = (id: string, cell: Cell) => `${id}:${cell === "ok" ? "ok" : cell}`;
  const expected = PLATFORM_OP_NAMES.flatMap((op, index) => [
    answer(`r${index + 1}`, MATRIX[type][op]),
    ...(childScripted && type !== "child" && MATRIX[type]["subagent.run"] === "ok"
      ? [answer(`r${index + 1}`, MATRIX.child[op])]
      : []),
  ]);
  // The daemon's rows are written before the worker hears its answers and appends them: wait for the file.
  await vi.waitFor(
    () => {
      const seen = rawAnswers(resultsFile(name)).map((entry) =>
        answer(entry.id, entry.ok ? "ok" : (entry.error as Cell)),
      );
      expect(seen.sort(), type).toEqual(expected.sort());
    },
    { timeout: 30_000, interval: 100 },
  );
}

const WEBHOOK_SOURCE = { type: "webhook", format: "alertmanager" } as const;
async function fireWebhook(trigger: { id: string; secret: string }, fingerprint: string): Promise<string> {
  const before = taskRowsOf(bed.t).length;
  const delivered = await deliver(bed.t, trigger.id, bearer(trigger.secret), alertBody("Disk", fingerprint));
  expect(delivered.status).toBe(202);
  let sessionId = "";
  await vi.waitFor(
    () => {
      const tasks = rows<{ session_id: string | null; state: string }>(
        bed.t.home,
        "SELECT session_id, state FROM tasks ORDER BY created_at, id",
      );
      expect(tasks).toHaveLength(before + 1);
      sessionId = tasks.at(-1)?.session_id ?? "";
      expect(sessionId).not.toBe("");
    },
    { timeout: 60_000 },
  );
  return sessionId;
}

describe("every op from every session type, agent sessions in the process-backend VM (M11R111)", () => {
  it("plain: every op is forbidden but subagent.run, which runs a child", async () => {
    armScript("plain");
    const before = effectsOf(bed.t);
    const { sessionId } = await call<{ sessionId: string }>("sessions.create", { cwd: bed.t.cwd });
    await call("sessions.prompt", { sessionId, text: "go" });
    await settled(sessionId);
    expectCells(sessionId, "plain");
    await expectAnswers("plain", "plain");
    const tools = await toolsOf(sessionId);
    expect(tools).toContain("bash");
    expect(tools.filter((name) => /^(agent_|lane_|secret_|network_|subagent)/.test(name))).toEqual([
      "subagent",
    ]);
    expect(effectsOf(bed.t)).toEqual(before);
  }, 90_000);

  it("lane: lane.note runs and sets the lane's note; the rest is forbidden", async () => {
    armScript("lane");
    const before = effectsOf(bed.t);
    const lane = await bed.createLane("Raw calls");
    let sessionId = "";
    await vi.waitFor(
      () => {
        sessionId = bed.views(lane.id).at(-1)?.primarySessionId ?? "";
        expect(sessionId).not.toBe("");
      },
      { timeout: 60_000 },
    );
    await settled(sessionId);
    expectCells(sessionId, "lane");
    await expectAnswers("lane", "lane");
    const tools = await toolsOf(sessionId);
    expect(tools).toContain("lane_note");
    expect(tools).toContain("subagent");
    expect(tools.filter((name) => /^(agent_|secret_|network_)/.test(name))).toEqual([]);
    expect(rows<{ note: string }>(bed.t.home, "SELECT note FROM lanes WHERE id = ?", lane.id)).toEqual([
      { note: "raw lane note" },
    ]);
    expect(effectsOf(bed.t)).toEqual({ ...before, laneNotes: before.laneNotes + 1 });
  }, 120_000);

  it("M10 task: nothing runs", async () => {
    armScript("task");
    const trigger = await createTrigger(bed.owner, webhookInput(bed.t, { source: WEBHOOK_SOURCE }));
    const before = effectsOf(bed.t);
    const sessionId = await fireWebhook(trigger, "t1");
    await settled(sessionId);
    expectCells(sessionId, "task");
    expect(effectsOf(bed.t)).toEqual(before);
  }, 120_000);

  it("agent task (isolated): nothing runs", async () => {
    armScript("agent-task");
    const trigger = await createTrigger(
      bed.owner,
      TriggerInput.parse({
        name: "Atlas alerts",
        enabled: true,
        source: WEBHOOK_SOURCE,
        execution: { agent: { agentId: atlas, target: "isolated" } },
        prompt: "Handle:\n{{payload}}",
      }),
    );
    const before = effectsOf(bed.t);
    const cardKinds = () =>
      rows<{ kind: string }>(
        bed.t.home,
        "SELECT kind FROM agent_events WHERE agent_id = ? ORDER BY id",
        atlas,
      ).map((card) => card.kind);
    const cardsBefore = cardKinds().length;
    const sessionId = await fireWebhook(trigger, "t2");
    await settled(sessionId);
    expectCells(sessionId, "agent-task");
    // The task's own card is the only one that appeared (no `notify`, no request card); no op changed anything.
    await vi.waitFor(() => expect(cardKinds().slice(cardsBefore)).toEqual(["isolated"]), { timeout: 30_000 });
    expect({ ...effectsOf(bed.t), cards: 0 }).toEqual({ ...before, cards: 0 });
  }, 120_000);

  it("agent thread: notify, approve, delegate, remind, secret and network requests run; lane.note is forbidden", async () => {
    armScript("thread");
    const before = effectsOf(bed.t);
    const { sessionId } = await call<{ sessionId: string }>("agents.openThread", { agentId: atlas });
    // Atlas's worker has read its script. Scout's worker, started by the delegation, reads a plain one.
    writeScript(bed.t, { steps: [{ text: "Done." }] });
    await call("sessions.prompt", { sessionId, text: "go" });
    await settled(sessionId, true);
    expectCells(sessionId, "agent-thread");
    await expectAnswers("thread", "agent-thread", false);
    // Scout's thread task has started and ended: no worker of the next case reads a script meant for another.
    await vi.waitFor(() => expect(taskRowsOf(bed.t, scout).map((task) => task.state)).toEqual(["done"]), {
      timeout: 60_000,
    });
    // The delegation's result card on Atlas's side is written just after the task ends: no later case counts it.
    await vi.waitFor(
      () =>
        expect(
          rows<{ n: number }>(
            bed.t.home,
            "SELECT count(*) AS n FROM agent_events WHERE agent_id = ? AND kind = 'delegation'",
            atlas,
          )[0]?.n,
        ).toBe(1),
      { timeout: 30_000 },
    );
    const after = effectsOf(bed.t);
    // notify: an Inbox item and a card; approve and secret: a request each (and an item each); delegate and remind: a task each.
    expect(after.requests - before.requests).toBe(2);
    expect(after.agentTasks - before.agentTasks).toBe(2);
    expect(after.laneNotes).toBe(before.laneNotes);
    expect(
      rows<{ kind: string }>(
        bed.t.home,
        "SELECT kind FROM agent_events WHERE agent_id = ? ORDER BY id",
        atlas,
      ).map((card) => card.kind),
    ).toContain("notify");
    expect(
      rows<{ kind: string }>(bed.t.home, "SELECT kind FROM inbox_items WHERE kind = 'agent_notify'"),
    ).toHaveLength(1);
    expect(requestRows(bed.t).map((request) => [request.kind, request.state])).toEqual([
      ["approve", "approved"],
      ["secret", "answered"],
    ]);
    expect(taskRowsOf(bed.t, scout)).toMatchObject([
      { origin: "delegate", target: "thread", requested_by: atlas, tainted: 0 },
    ]);
    expect(taskRowsOf(bed.t, atlas).find((task) => task.origin === "remind")).toMatchObject({
      state: "queued",
      target: "thread",
    });
    // RT-09: the thread's worker offers exactly the tools its type may call: `subagent`, no `lane_note`.
    const tools = await toolsOf(sessionId);
    expect(tools).toEqual(
      expect.arrayContaining([
        "agent_notify",
        "agent_approve",
        "agent_delegate",
        "agent_remind",
        "secret_request",
        "network_request",
        "subagent",
      ]),
    );
    expect(tools).not.toContain("lane_note");
    // network.request ran: no host was granted by the raw call itself.
    expect(rawAnswers(resultsFile("thread"))).toContainEqual(
      expect.objectContaining({ id: "r7", ok: true, result: { granted: false } }),
    );
  }, 180_000);

  it("child: nothing runs, whatever the parent's agent may do", async () => {
    // The agent's thread is opened here (it is the same one when an earlier case opened it): no dependence on that case.
    const { sessionId: parent } = await call<{ sessionId: string }>("agents.openThread", { agentId: atlas });
    armScript("child");
    const id = "child-session-1";
    const now = Date.now();
    // Task 29b's port is not here yet: the child row is made the way the store's own tests make one.
    const db = openDatabase(join(bed.t.home, "state.db"));
    try {
      db.run(
        `INSERT INTO sessions (id, cwd, owner_id, created_at, updated_at, parent_session_id, agent_id, agent_role)
         SELECT $id, $cwd, owner_id, $now, $now, $parent, id, 'child' FROM agents WHERE id = $agent`,
        { id, cwd: join(bed.t.home, "agents", atlas), now, parent, agent: atlas },
      );
    } finally {
      db.close();
    }
    const before = effectsOf(bed.t);
    await call("sessions.prompt", { sessionId: id, text: "go" });
    await settled(id);
    expectCells(id, "child");
    await expectAnswers("child", "child");
    expect(effectsOf(bed.t)).toEqual(before);
  }, 120_000);

  it("an op outside the table is dropped by the parser: no answer, no row, no effect", async () => {
    armScript("unknown", [
      rawStep([{ op: "agent.explode", toolCallId: "raw-x", args: {} }, rawCall("lane.note")]),
    ]);
    const dropsBefore = logs.lines.filter((line) => line["msg"] === "worker_record_dropped").length;
    const before = effectsOf(bed.t);
    const { sessionId } = await call<{ sessionId: string }>("sessions.create", { cwd: bed.t.cwd });
    await call("sessions.prompt", { sessionId, text: "go" });
    // r2 is answered (forbidden: a plain session); r1, the op that is not in the table, never is.
    await vi.waitFor(() => expect(rawAnswers(resultsFile("unknown"))).toHaveLength(1), { timeout: 30_000 });
    expect(rawAnswers(resultsFile("unknown"))).toMatchObject([{ id: "r2", ok: false, error: "forbidden" }]);
    expect(opRows(bed.t, sessionId).map((row) => row.tool)).toEqual(["lane.note"]);
    expect(logs.lines.filter((line) => line["msg"] === "worker_record_dropped").length).toBeGreaterThan(
      dropsBefore,
    );
    expect(effectsOf(bed.t)).toEqual(before);
  }, 90_000);
});
