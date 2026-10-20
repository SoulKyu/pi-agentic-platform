import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventFrame } from "@pap/contracts";
import { createSystemClock } from "../../kernel/clock.ts";
import { drainOutboxOf } from "../../testing/usage-seam.ts";
import { bash, codeOf, writeScript } from "../../security/testing/agent-bed.ts";
import { rows } from "../../security/testing/automation-bed.ts";
import { isDialog, markOf, waitIdle } from "../../security/testing/fixtures.ts";
import { startVmBed, type VmBed } from "../../testing/vm-bed.ts";

let bed: VmBed | undefined;
afterEach(async () => {
  await bed?.stop();
  bed = undefined;
});
const start = (script: object, options: Parameters<typeof startVmBed>[1] = {}) =>
  startVmBed(script, options).then((started) => (bed = started));

/** The mirror files of an agent, as the daemon keeps them (R23). */
const mirrorFiles = (b: VmBed, agentId: string): string[] => {
  const dir = join(b.t.home, "agents", ".mirrors", agentId);
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".jsonl")) : [];
};
const prompt = async (b: VmBed, sessionId: string, text: string) => {
  const mark = markOf(b.owner.client);
  await b.call("sessions.prompt", { sessionId, text });
  await waitIdle(b.owner.client, mark);
};
const LIMIT_TEXT = "You have hit your ChatGPT usage limit (plus plan). Try again in ~1 min.";
const kind = (name: string) => (frame: EventFrame) => (frame.event as { kind?: string }).kind === name;
const runLines = (b: VmBed): Array<Record<string, unknown>> =>
  readFileSync(join(b.t.home, "logs", "runs.jsonl"), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
const texts = (b: VmBed): string => JSON.stringify(b.owner.client.events);

describe("an agent thread in a VM (process backend, T8a T8b T11b)", () => {
  it("answers a prompt through the session stream, keeps its transcript in the mirror and stops with the daemon", async () => {
    const b = await start({ steps: [{ text: "Hello from the VM." }] });
    const agentId = await b.createAgent();
    const sessionId = await b.openThread(agentId);
    await prompt(b, sessionId, "Say hello");
    expect(texts(b).includes("Hello from the VM.")).toBe(true);
    expect(b.vms.started).toHaveLength(1);
    const [file] = mirrorFiles(b, agentId);
    expect(file).toBeDefined();
    expect(
      readFileSync(join(b.t.home, "agents", ".mirrors", agentId, file as string), "utf8").includes(
        "Hello from the VM.",
      ),
    ).toBe(true);
    await b.t.daemon.stop();
    expect(b.vms.stopped.some((vm) => vm.agentId === agentId)).toBe(true);
  }, 120_000);

  it("a second open reuses the VM, and a reopen resumes the same session file (AVM-P9)", async () => {
    const b = await start({ steps: [{ text: "First answer." }, { text: "Second answer." }] });
    const agentId = await b.createAgent();
    const sessionId = await b.openThread(agentId);
    await prompt(b, sessionId, "First question");
    const files = mirrorFiles(b, agentId);
    expect(files).toHaveLength(1);
    // Crossing the Chat boundary releases the worker; the next prompt starts a new one in the same VM.
    await b.call("sessions.setTools", { sessionId, preset: "chat" });
    await b.call("sessions.setTools", { sessionId, preset: "full" });
    expect(await b.call("agents.openThread", { agentId })).toMatchObject({ sessionId });
    // The next worker copies the script again at its start.
    writeScript(b.t, { steps: [{ text: "Second answer." }] });
    await prompt(b, sessionId, "Second question");
    expect(b.vms.started).toHaveLength(1);
    // Same file, both exchanges, and the VM's own folder holds that one file only.
    expect(mirrorFiles(b, agentId)).toEqual(files);
    const text = readFileSync(join(b.t.home, "agents", ".mirrors", agentId, files[0] as string), "utf8");
    expect(text.includes("First answer.")).toBe(true);
    expect(text.includes("Second answer.")).toBe(true);
    const vmSessions = join(b.t.home, "tmp", "agent-vm", agentId, ".pi", "sessions");
    expect(readdirSync(vmSessions)).toEqual(files);
  }, 120_000);

  it("allows a shell call with no question, in Full Access, and leaves its audit row (R15)", async () => {
    // The process backend cannot run R2's root shell (T20b does): the call is judged, then fails to run.
    const b = await start({ steps: [bash("echo hello-from-vm", "b1"), { text: "Shell done." }] });
    const sessionId = await b.openThread(await b.createAgent());
    await prompt(b, sessionId, "Run it");
    expect(b.owner.client.events.some(isDialog)).toBe(false);
    const calls = rows<{ decision: string }>(
      b.t.home,
      "SELECT decision FROM audit WHERE session_id = ? AND kind = 'call' AND tool = 'bash' ORDER BY id",
      sessionId,
    );
    expect(calls.map((row) => row.decision)).toEqual(["allow"]);
    expect(texts(b).includes("Shell done.")).toBe(true);
  }, 120_000);

  it("answers export_html with sandbox_unavailable and writes nothing (R37)", async () => {
    const b = await start({ steps: [{ text: "Something to export." }] });
    const sessionId = await b.openThread(await b.createAgent());
    await prompt(b, sessionId, "Hello");
    expect(codeOf(await b.owner.client.call("sessions.exportHtml", { sessionId }))).toBe(
      "sandbox_unavailable",
    );
  }, 120_000);

  // RT-10 / R38 and the T8a carry: "a full-access VM thread resumes" through the real resume path. A full-access
  // continuation nobody watches needs a sandboxed worker, and a VM worker is one (`sandboxedThread` reads `agentLaunch.vm`).
  // Mutants (run for real): compose-usage.ts:67 `sandboxedAgent: () => false`, and service-launch's `vm` not counted as sandboxed.
  it("resumes a full-access thread after a quota stop, unattended, through the real resume path (RT-10)", async () => {
    const shift = { ms: 0 };
    const clock = { ...createSystemClock(), now: () => Date.now() + shift.ms };
    const b = await start(
      { steps: [{ stopReason: "error", errorMessage: LIMIT_TEXT }, { text: "Picked up again." }] },
      { deps: { clock } },
    );
    const sessionId = await b.openThread(await b.createAgent());
    await b.call("subscribe.usage", {});
    await b.owner.client.waitForEvent(kind("snapshot"));
    await b.call("sessions.prompt", { sessionId, text: "Do the long job" });
    const limited = await b.owner.client.waitForEvent(kind("limit"));
    expect((limited.event as { limit: unknown }).limit).toMatchObject({ sessionId, resume: "scheduled" });
    await vi.waitFor(() => expect(runLines(b)).toHaveLength(1), { timeout: 20_000 });
    expect(runLines(b)[0]).toMatchObject({ status: "limited", errorClass: "usage_limit", sessionId });
    shift.ms = 5 * 60_000;
    expect(await drainOutboxOf(b.t.home)?.()).toBe(1);
    await vi.waitFor(() => expect(runLines(b)).toHaveLength(2), { timeout: 20_000 });
    expect(runLines(b)[1]).toMatchObject({ status: "completed", origin: "resume", sessionId });
    expect(texts(b).includes("Picked up again.")).toBe(true);
  }, 120_000);
});
