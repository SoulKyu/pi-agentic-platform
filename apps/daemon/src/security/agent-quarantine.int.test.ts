import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentInput } from "@pap/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startTestDaemon, type TestDaemon } from "../testing/harness.ts";
import { openOwner, type Owner, result, rows } from "./testing/automation-bed.ts";
import { taskRowsOf } from "./testing/agent-bed.ts";
import { dialogIdOf, markOf, nextDialog, waitIdle } from "./testing/fixtures.ts";
import { createSteppableClock, type SteppableClock } from "./testing/steppable-clock.ts";

// W5-R64 I4: quarantining an agent also ends the delegations it REQUESTED. Atlas asks a busy Scout (its thread waits for
// the owner's answer), Atlas is quarantined, and the queued request ends `cancelled`: it never reaches Scout's thread.
const BOARD = "Check the board";
let t: TestDaemon;
let owner: Owner;
let clock: SteppableClock;
let scratch: string;

const call = async <T>(method: string, params: object): Promise<T> =>
  result<T>(await owner.client.call(method as never, params as never));
const userLines = (): string => readFileSync(join(scratch, "users.jsonl"), "utf8");
const scriptOf = (steps: object[]) => ({ steps, captureUserMessages: join(scratch, "users.jsonl") });
const writeScript = (steps: object[]): void =>
  writeFileSync(join(t.root, "script.json"), JSON.stringify(scriptOf(steps)));

beforeAll(async () => {
  clock = createSteppableClock();
  scratch = mkdtempSync(join(tmpdir(), "pap-quarantine-"));
  // The first worker to start is Scout's: it asks the owner before writing, and stays asking.
  t = await startTestDaemon(
    scriptOf([
      { toolCalls: [{ name: "write", args: { path: "x.txt", content: "x" }, id: "w1" }] },
      { text: "Written." },
    ]),
    { deps: { clock } },
  );
  owner = await openOwner(t);
});
afterAll(async () => {
  owner.client.close();
  await t.stop();
  rmSync(scratch, { recursive: true, force: true });
});

describe("quarantine and the delegations the agent requested (W5-R64 I4)", () => {
  it("cancels Atlas's queued request to a busy Scout, and Scout's thread gets no prompt", async () => {
    const scout = (
      await call<{ id: string }>("agents.create", {
        input: AgentInput.parse({
          name: "Scout",
          preset: "default",
          mode: "supervised",
          sandbox: { required: false },
          acceptsDelegation: true,
        }),
      })
    ).id;
    const atlas = (
      await call<{ id: string }>("agents.create", {
        input: AgentInput.parse({ name: "Atlas", preset: "read-only", sandbox: { required: false } }),
      })
    ).id;
    const scoutThread = (await call<{ sessionId: string }>("agents.openThread", { agentId: scout }))
      .sessionId;
    await call("subscribe.session", { sessionId: scoutThread });
    const scoutMark = markOf(owner.client);
    await call("sessions.prompt", { sessionId: scoutThread, text: "Write the file." });
    const question = await nextDialog(owner.client, scoutMark);

    // Scout waits for an answer: it is busy. Atlas's worker is the next to start.
    writeScript([
      { toolCalls: [{ name: "agent_delegate", args: { agent: "Scout", task: BOARD }, id: "d1" }] },
      { text: "Delegated." },
    ]);
    const atlasThread = (await call<{ sessionId: string }>("agents.openThread", { agentId: atlas }))
      .sessionId;
    await call("subscribe.session", { sessionId: atlasThread });
    const atlasMark = markOf(owner.client);
    await call("sessions.prompt", { sessionId: atlasThread, text: "Ask Scout to check the board." });
    await waitIdle(owner.client, atlasMark);
    await vi.waitFor(() => expect(taskRowsOf(t, scout).map((task) => task.state)).toEqual(["queued"]), {
      timeout: 30_000,
    });
    expect(taskRowsOf(t, scout)[0]).toMatchObject({ origin: "delegate", requested_by: atlas });

    await call("agents.quarantine", { agentId: atlas });
    expect(taskRowsOf(t, scout)[0]).toMatchObject({ state: "cancelled", reason: "cancelled" });

    // Scout is free again, and a clock past every wait changes nothing: no prompt, no run.
    await call("sessions.respondDialog", {
      sessionId: scoutThread,
      dialogId: dialogIdOf(question),
      response: { answer: "deny" },
    });
    await waitIdle(owner.client, scoutMark);
    await clock.advance(60_000);
    expect(taskRowsOf(t, scout).map((task) => [task.state, task.reason])).toEqual([
      ["cancelled", "cancelled"],
    ]);
    expect(userLines()).not.toContain(BOARD);
  }, 120_000);

  it("cancels a request that is already running in Scout's thread and aborts its run", async () => {
    // Scout2's worker starts first and keeps its script: a write the owner is asked about, so the request stays running.
    writeScript([
      { toolCalls: [{ name: "write", args: { path: "y.txt", content: "y" }, id: "w2" }] },
      { text: "Written." },
    ]);
    const scout = (
      await call<{ id: string }>("agents.create", {
        input: AgentInput.parse({
          name: "Scout2",
          preset: "default",
          mode: "supervised",
          sandbox: { required: false },
          acceptsDelegation: true,
        }),
      })
    ).id;
    const atlas = (
      await call<{ id: string }>("agents.create", {
        input: AgentInput.parse({ name: "Atlas2", preset: "read-only", sandbox: { required: false } }),
      })
    ).id;
    const scoutThread = (await call<{ sessionId: string }>("agents.openThread", { agentId: scout }))
      .sessionId;
    writeScript([
      { toolCalls: [{ name: "agent_delegate", args: { agent: "Scout2", task: BOARD }, id: "d2" }] },
      { text: "Delegated." },
    ]);
    const atlasThread = (await call<{ sessionId: string }>("agents.openThread", { agentId: atlas }))
      .sessionId;
    await call("subscribe.session", { sessionId: atlasThread });
    const mark = markOf(owner.client);
    await call("sessions.prompt", { sessionId: atlasThread, text: "Ask Scout2 to check the board." });
    await waitIdle(owner.client, mark);
    await vi.waitFor(() => expect(taskRowsOf(t, scout).map((task) => task.state)).toEqual(["running"]), {
      timeout: 30_000,
    });
    const runStatus = () =>
      rows<{ status: string }>(t.home, "SELECT status FROM runs WHERE session_id = ?", scoutThread).map(
        (run) => run.status,
      );
    // The task is marked running before its run row is written: wait for the row (FLAKE-W5-8).
    await vi.waitFor(() => expect(runStatus()).toContain("running"), { timeout: 30_000 });

    await call("agents.quarantine", { agentId: atlas });
    expect(taskRowsOf(t, scout)[0]).toMatchObject({ state: "cancelled", reason: "cancelled" });
    await vi.waitFor(() => expect(runStatus()).not.toContain("running"), { timeout: 30_000 });
  }, 120_000);
});
