import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AgentInput } from "@pap/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { captureLogger } from "../testing/capture-logger.ts";
import { startTestDaemon, type TestDaemon } from "../testing/harness.ts";
import { callOf, writeScript } from "./testing/agent-bed.ts";
import { openOwner, result, rows, type Owner } from "./testing/automation-bed.ts";
import { markOf, waitIdle } from "./testing/fixtures.ts";

// ADR 0081: the vault's values and the one-use values reach a VM session, on the process-backend VM. The process backend
// cannot run the root VM shell (`vm-shell/ops.vault.test.ts` proves what the shell is given and the Kata suite the real
// one), so a value is observed where the worker redacts: a scripted step that echoes it. A value the worker does not
// hold would come back raw; one it holds comes back as `[SECRET:NAME]`. Everything the daemon writes is read back.
const value = () => `pap-test-secret-${randomBytes(4).toString("hex")}`;
const VAULT = value();
const LIVE = value();
const ONCE = value();
const SAVED = value();
const ALL = [VAULT, LIVE, ONCE, SAVED];
const found = (text: string) => ALL.filter((secret) => text.includes(secret));
const request = (name: string, id: string) => ({
  toolCalls: [{ name: "secret_request", args: { name, reason: "to read the dashboards" }, id }],
});

const logs = captureLogger();
let t: TestDaemon;
let owner: Owner;
let call: ReturnType<typeof callOf>;
const dump: string[] = [];
const tracked = async <T>(method: string, params: object): Promise<T> => {
  const frame = await owner.client.call(method as never, params as never);
  dump.push(JSON.stringify(frame));
  return result<T>(frame);
};

beforeAll(async () => {
  t = await startTestDaemon(
    { steps: [{ text: "placeholder" }] },
    { vm: true, deps: { logger: logs.logger } },
  );
  owner = await openOwner(t);
  call = callOf(owner.client);
}, 120_000);
afterAll(async () => {
  owner?.client.close();
  await t?.stop();
});

const newAgent = async (name: string): Promise<string> =>
  (
    await call<{ id: string }>("agents.create", {
      input: AgentInput.parse({ name, preset: "full", mode: "full-access" }),
    })
  ).id;

/** Each thread's subscription: one client follows every thread here, and seq restarts per subscription. */
const subs = new Map<string, string>();
async function openThread(agentId: string, steps: object[]): Promise<{ sessionId: string; mark: number }> {
  writeScript(t, { steps });
  const { sessionId } = await call<{ sessionId: string }>("agents.openThread", { agentId });
  const { sub } = await call<{ sub: string }>("subscribe.session", { sessionId });
  subs.set(sessionId, sub);
  return { sessionId, mark: markOf(owner.client, sub) };
}
const prompt = async (sessionId: string, text = "go"): Promise<void> => {
  const sub = subs.get(sessionId);
  const mark = markOf(owner.client, sub);
  await call("sessions.prompt", { sessionId, text });
  await waitIdle(owner.client, mark, sub);
};
/** What the model's typed text looked like on the stream, pieces joined. */
const streamed = (): string =>
  owner.client.events
    .map(
      (frame) =>
        (frame.event as { event?: { assistantMessageEvent?: { type?: string; delta?: string } } }).event,
    )
    .filter((event) => /_delta$/.test(event?.assistantMessageEvent?.type ?? ""))
    .map((event) => event?.assistantMessageEvent?.delta ?? "")
    .join("");
const pending = async (): Promise<string> => {
  let id = "";
  await vi.waitFor(
    () => {
      id = rows<{ id: string }>(t.home, "SELECT id FROM agent_requests WHERE state = 'pending'")[0]?.id ?? "";
      expect(id).not.toBe("");
    },
    { timeout: 60_000 },
  );
  return id;
};

describe("the vault in a VM session (ADR 0081)", () => {
  it("redacts a vault value a VM worker prints, from the first byte", async () => {
    const atlas = await newAgent("Atlas");
    await tracked("secrets.set", { agentId: atlas, name: "LEAK_VAULT", value: VAULT });
    const { sessionId } = await openThread(atlas, [{ text: `the token is ${VAULT}, done` }]);
    await prompt(sessionId);
    expect(streamed()).toContain("the token is [SECRET:LEAK_VAULT], done");
    expect(found(streamed())).toEqual([]);
  }, 120_000);

  it("delivers a live vault update to the running worker", async () => {
    const bolt = await newAgent("Bolt");
    const { sessionId } = await openThread(bolt, [{ text: "first" }, { text: `second ${LIVE}` }]);
    await prompt(sessionId);
    // Added mid-thread: the worker is told by a vault_update, before the next prompt reaches it.
    await tracked("secrets.set", { agentId: bolt, name: "LEAK_LIVE", value: LIVE });
    await prompt(sessionId, "again");
    expect(streamed()).toContain("second [SECRET:LEAK_LIVE]");
    expect(found(streamed())).toEqual([]);
  }, 120_000);

  it("lets a VM session ask for a secret: the card is shown, a one-use value reaches the worker, a saved one the vault", async () => {
    const cleo = await newAgent("Cleo");
    const { sessionId, mark } = await openThread(cleo, [
      request("LEAK_ONCE", "sr1"),
      request("LEAK_SAVED", "sr2"),
      { text: `got ${ONCE} and ${SAVED}` },
    ]);
    await call("sessions.prompt", { sessionId, text: "go" });
    const first = await pending();
    expect(rows(t.home, "SELECT kind, title FROM agent_requests WHERE id = ?", first)).toEqual([
      { kind: "secret", title: "LEAK_ONCE" },
    ]);
    await tracked("secrets.answerRequest", { requestId: first, value: ONCE, mode: "once" });
    const second = await pending();
    await tracked("secrets.answerRequest", { requestId: second, value: SAVED, mode: "vault" });
    await vi.waitFor(() => expect(streamed()).toContain("got "), { timeout: 60_000 });
    await waitIdle(owner.client, mark, subs.get(sessionId));
    expect(streamed()).toContain("got [SECRET:LEAK_ONCE] and [SECRET:LEAK_SAVED]");
    const names = await call<{ entries: Array<{ name: string }> }>("secrets.list", { agentId: cleo });
    expect(names.entries.map((entry) => entry.name)).toEqual(["LEAK_SAVED"]);
  }, 120_000);

  it("leaves no value in the daemon's log, its tables, the RPC results or the events of the run", () => {
    expect(found(JSON.stringify(logs.lines))).toEqual([]);
    expect(found(readFileSync(join(t.home, "logs", "trace.jsonl"), "utf8"))).toEqual([]);
    for (const table of ["audit", "session_events", "tasks", "agent_events", "agent_requests", "inbox_items"])
      expect(found(JSON.stringify(rows(t.home, `SELECT * FROM ${table}`))), table).toEqual([]);
    expect(found(dump.join("\n"))).toEqual([]);
    expect(found(JSON.stringify(owner.client.events))).toEqual([]);
  });
});
