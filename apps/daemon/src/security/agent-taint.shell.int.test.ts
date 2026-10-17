import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentInput, type EgressStatus, TriggerInput } from "@pap/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSystemClock } from "../kernel/clock.ts";
import { probePython } from "../modules/egress/python-probe.ts";
import { FETCH } from "../modules/egress/testing/worker-scripts.ts";
import { startTestDaemon, type TestDaemon } from "../testing/harness.ts";
import { bash, bwrapUsable, callOf, taskRowsOf, writeScript } from "./testing/agent-bed.ts";
import {
  alertBody,
  bearer,
  createTrigger,
  deliver,
  openOwner,
  type Owner,
  rows,
} from "./testing/automation-bed.ts";
import { markOf, waitIdle } from "./testing/fixtures.ts";

// A shell's taint comes from what it reached, never from the fact that it ran (RT-02, M11R233), and an isolated task
// cannot ask for hosts (carry 7: Pi 1.1.0 has no URL tool, so the shell is the way to the network). Real bwrap, python
// for the proxy's forwarder, and no host name that resolves: a refused host is refused before any lookup (W5-R50).
const python: EgressStatus = await probePython({ clock: createSystemClock() });
const usable = bwrapUsable("agent-taint.shell.int.test") && python.usable;
if (!python.usable && process.env["CI"])
  throw new Error("agent-taint.shell.int.test: CI must provide python3");

interface Stage {
  readonly stage: string;
  readonly outcome: string;
  readonly reason?: string;
}
const LISTED = "allowed.test";
const UNLISTED = "unlisted.test";

describe.skipIf(!usable)("a shell taints only from what it reached (RT-02, M11R233)", () => {
  let t: TestDaemon;
  let owner: Owner;
  let call: ReturnType<typeof callOf>;
  let dir: string;
  const taintOf = (sessionId: string): number | null =>
    rows<{ tainted_at: number | null }>(
      t.home,
      "SELECT tainted_at FROM session_policy WHERE session_id = ?",
      sessionId,
    )[0]?.tainted_at ?? null;

  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "pap-shell-")));
    // A thread keeps its worker: three of them and a task need more than the default four.
    t = await startTestDaemon({ steps: [{ text: "placeholder" }] }, { config: { maxWorkers: 10 } });
    owner = await openOwner(t);
    call = callOf(owner.client);
  });
  afterAll(async () => {
    owner?.client.close();
    await t?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  /** The stages of the tool result the worker audited last: the worker's own judgment of what the command did. */
  async function resultStages(sessionId: string): Promise<Stage[]> {
    let stages: Stage[] = [];
    await vi.waitFor(
      () => {
        const [row] = rows<{ stages: string }>(
          t.home,
          "SELECT stages FROM audit WHERE session_id = ? AND kind = 'result' ORDER BY id DESC LIMIT 1",
          sessionId,
        );
        expect(row).toBeDefined();
        stages = JSON.parse(row?.stages ?? "[]") as Stage[];
      },
      { timeout: 20_000 },
    );
    return stages;
  }
  const stage07 = async (sessionId: string) =>
    (await resultStages(sessionId)).find((entry) => entry.stage === "07");

  /** A tool's whole output; its entry reaches the daemon a moment after the run's idle. */
  async function outputOf(sessionId: string, toolCallId: string): Promise<string> {
    let text = "";
    await vi.waitFor(
      async () => {
        const frame = await owner.client.call("sessions.toolOutput", { sessionId, toolCallId });
        expect(frame.ok).toBe(true);
        text = (frame as { result: { text: string } }).result.text;
      },
      { timeout: 20_000 },
    );
    return text;
  }

  /** A thread whose first worker reads `steps`; the run ends, and the session's taint is read back. */
  async function runThread(name: string, input: Partial<AgentInput>, steps: object[]) {
    const agent = (
      await call<{ id: string }>("agents.create", {
        input: AgentInput.parse({ name, preset: "full", mode: "full-access", ...input }),
      })
    ).id;
    writeFileSync(join(t.home, "agents", agent, "fetch.py"), FETCH);
    writeScript(t, { steps });
    const { sessionId } = await call<{ sessionId: string }>("agents.openThread", { agentId: agent });
    writeScript(t, { steps: [{ text: "Noted." }] });
    await call("subscribe.session", { sessionId });
    const mark = markOf(owner.client);
    await call("sessions.prompt", { sessionId, text: "go" });
    await waitIdle(owner.client, mark);
    return { agent, sessionId };
  }

  it("a network-off agent's `bash ls` leaves the thread untainted (RT-02)", async () => {
    const { sessionId } = await runThread("Offline", { sandbox: { required: true, network: false } }, [
      bash("ls", "ls"),
      { text: "done" },
    ]);
    // Stage 07 acted on nothing: no network was used, so there is no report to read and nothing to taint.
    await vi.waitFor(
      () =>
        expect(
          rows(t.home, "SELECT id FROM audit WHERE session_id = ? AND kind = 'call'", sessionId),
        ).toHaveLength(1),
      { timeout: 30_000 },
    );
    expect(taintOf(sessionId)).toBeNull();
  }, 90_000);

  it("a networked agent's command that reaches nothing leaves the thread untainted", async () => {
    const { sessionId } = await runThread(
      "Online",
      { sandbox: { required: true, network: true }, allowHosts: [LISTED] },
      [bash(`python3 -c "print('nothing-reached')"`, "quiet"), { text: "done" }],
    );
    expect(await stage07(sessionId)).toEqual({
      stage: "07",
      outcome: "pass",
      reason: "egress: no network used",
    });
    expect(taintOf(sessionId)).toBeNull();
    const out = await outputOf(sessionId, "quiet");
    expect(out).toContain("nothing-reached");
  }, 90_000);

  it("a networked command that only asked for a refused host does not taint, and the line names the refusal", async () => {
    const { sessionId } = await runThread(
      "Prober",
      { sandbox: { required: true, network: true }, allowHosts: [LISTED] },
      [bash(`python3 fetch.py http://${UNLISTED}/x`, "probe"), { text: "done" }],
    );
    const out = await outputOf(sessionId, "probe");
    expect(out).toContain(`403 pap egress proxy: ${UNLISTED}`);
    expect(out).toContain(`The egress proxy refused: ${UNLISTED} (not on this agent's host list)`);
    expect(out).toContain('ask the owner with network_request {"host": "unlisted.test"}');
    expect(await stage07(sessionId)).toEqual({
      stage: "07",
      outcome: "pass",
      reason: "egress: no network used",
    });
    expect(taintOf(sessionId)).toBeNull();
  }, 90_000);

  it("an isolated task's networked shell to an unlisted host is refused by the proxy, and the line says a task cannot ask for more", async () => {
    const agent = (
      await call<{ id: string }>("agents.create", {
        input: AgentInput.parse({
          name: "Tasker",
          preset: "full",
          sandbox: { required: true, network: true },
          allowHosts: [LISTED],
        }),
      })
    ).id;
    const home = join(t.home, "agents", agent);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "fetch.py"), FETCH);
    const trigger = await createTrigger(
      owner.client,
      TriggerInput.parse({
        name: "Tasker alerts",
        enabled: true,
        source: { type: "webhook", format: "alertmanager" },
        execution: {
          agent: { agentId: agent, target: "isolated" },
          tools: ["bash"],
          mode: "auto-accept-edits",
        },
        prompt: "Handle:\n{{payload}}",
      }),
    );
    writeScript(t, {
      steps: [bash(`python3 ${home}/fetch.py http://${UNLISTED}/x`, "task-probe"), { text: "done" }],
    });
    expect((await deliver(t, trigger.id, bearer(trigger.secret), alertBody("Disk", "f1"))).status).toBe(202);
    // A shell with network asks the owner, even in a task; the owner answers on the task's own session.
    let sessionId = "";
    await vi.waitFor(
      () => {
        sessionId = taskRowsOf(t, agent)[0]?.session_id ?? "";
        expect(sessionId).not.toBe("");
      },
      { timeout: 60_000 },
    );
    const side = await t.connect(owner.cookie);
    try {
      await side.call("subscribe.session", { sessionId });
      // The card may already be open when the subscription starts (then it is in the snapshot, not an event).
      let dialogId = "";
      await vi.waitFor(
        () => {
          const ids = side.events.flatMap((frame) => {
            const event = frame.event as {
              kind?: string;
              dialog?: { id: string };
              dialogs?: Array<{ id: string }>;
            };
            return event.kind === "dialog_open" && event.dialog
              ? [event.dialog.id]
              : event.kind === "snapshot"
                ? (event.dialogs ?? []).map((open) => open.id)
                : [];
          });
          dialogId = ids[0] ?? "";
          expect(dialogId).not.toBe("");
        },
        { timeout: 30_000 },
      );
      await side.call("sessions.respondDialog", { sessionId, dialogId, response: { answer: "once" } });
    } finally {
      side.close();
    }
    await vi.waitFor(() => expect(taskRowsOf(t, agent).map((task) => task.state)).toEqual(["done"]), {
      timeout: 60_000,
    });
    const out = await outputOf(sessionId, "task-probe");
    expect(out).toContain(`403 pap egress proxy: ${UNLISTED}`);
    expect(out).toContain(
      `[pap] The egress proxy refused: ${UNLISTED} (not on this agent's host list). An isolated task cannot ask for more hosts.`,
    );
    // The proxy's own 403 body says where to ask (the agent's thread); pap's line, the model's last word, offers no tool.
    expect(out.split("\n").find((line) => line.startsWith("[pap]"))).not.toContain("network_request");
  }, 120_000);
});
