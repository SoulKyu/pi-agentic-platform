import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { AgentInput, TriggerInput } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../kernel/config.ts";
import { startTestDaemon, type TestDaemon } from "../testing/harness.ts";
import {
  alertBody,
  bearer,
  createTrigger,
  deliver,
  journalOf,
  openOwner,
  rows,
} from "./testing/automation-bed.ts";
import { callOf, codeOf, spawnCounting, spawnsOf, taskRowsOf } from "./testing/agent-bed.ts";
import { killWorkerOf } from "./testing/fixtures.ts";
import { createSteppableClock } from "./testing/steppable-clock.ts";

// The roadmap's second M11 exit criterion: "a sandbox-required agent refuses to start without bwrap (fail closed)". A whole
// daemon, real workers, and a sandbox that is not there in four ways: a root-owned binary that refuses (`PAP_BWRAP=
// /usr/bin/false`), one that exits 0 without sandboxing (`/usr/bin/true`, refused by the canary, RT-14), none at all
// (`missing`) and one that never answers (`timeout`, the probe's own spawn seam). Every start of a sandbox-required agent
// is refused `sandbox_unavailable` and no worker (the spawn log of the workers) and no command starts; a sandbox-off agent
// still starts. The probe itself needs no bwrap, so this half runs everywhere.
const ONE_WORD = { required: true, network: false } as const;

type Reason = "refused" | "missing" | "timeout";
interface Broken {
  readonly name: string;
  readonly reason: Reason;
  readonly config: Partial<Config>;
  readonly hangs?: true;
}
const BROKEN: readonly Broken[] = [
  {
    name: "a root-owned binary that refuses (PAP_BWRAP=/usr/bin/false)",
    reason: "refused",
    config: { bwrapOverride: "/usr/bin/false" },
  },
  {
    name: "a root-owned binary that exits 0 without sandboxing (PAP_BWRAP=/usr/bin/true)",
    reason: "refused",
    config: { bwrapOverride: "/usr/bin/true" },
  },
  { name: "no bwrap at all", reason: "missing", config: { bwrapOverride: "/nonexistent/pap/bwrap" } },
  {
    name: "a bwrap that never answers",
    reason: "timeout",
    config: { bwrapOverride: "/usr/bin/false" },
    hangs: true,
  },
];

/** A child process that never says anything and never ends: what the probe sees of a hung bwrap. */
const hungChild = () => Object.assign(new EventEmitter(), { pid: undefined, stdout: new PassThrough() });

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe.each(BROKEN)("fail closed: $name", (broken) => {
  it(`refuses every start of a sandbox-required agent as sandbox_unavailable (${broken.reason}) and spawns nothing`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pap-sbx-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const spawnLog = join(dir, "spawns.log");
    const clock = createSteppableClock();
    const counting = spawnCounting(spawnLog);
    const t: TestDaemon = await startTestDaemon(
      { steps: [{ text: "Hello." }] },
      {
        ...counting,
        config: { ...counting.config, ...broken.config },
        deps: { clock, ...(broken.hangs ? { sandboxSpawn: (() => hungChild()) as never } : {}) },
      },
    );
    cleanups.push(() => t.stop());
    const owner = await openOwner(t);
    cleanups.push(() => owner.client.close());
    const call = callOf(owner.client);

    // The boot probe ends: the hung one only when its five seconds are up on the daemon's clock.
    if (broken.hangs) await clock.advance(5_000);
    await vi.waitFor(
      async () => {
        const status = await call<{ usable: boolean; reason: string | null; checkedAt: number }>(
          "agents.sandboxStatus",
          {},
        );
        expect(status.checkedAt).toBeGreaterThan(0);
      },
      { timeout: 30_000 },
    );
    // The agent's settings say why.
    expect(await call("agents.sandboxStatus", {})).toMatchObject({ usable: false, reason: broken.reason });

    const required = AgentInput.parse({ name: "Atlas", sandbox: ONE_WORD });
    const atlas = (await call<{ id: string }>("agents.create", { input: required })).id;

    // 1. A thread cannot open: a refusal, no session, no worker.
    expect(codeOf(await owner.client.call("agents.openThread", { agentId: atlas }))).toBe(
      "sandbox_unavailable",
    );
    expect(await call<{ sessions: unknown[] }>("sessions.list", {})).toMatchObject({ sessions: [] });
    expect(spawnsOf(spawnLog)).toBe(0);

    // 2. A sandbox-off agent still starts (the owner chose it).
    const open = (
      await call<{ id: string }>("agents.create", {
        input: AgentInput.parse({ name: "Bolt", sandbox: { required: false } }),
      })
    ).id;
    const boltThread = (await call<{ sessionId: string }>("agents.openThread", { agentId: open })).sessionId;
    await vi.waitFor(() => expect(spawnsOf(spawnLog)).toBe(1), { timeout: 30_000 });
    expect(t.daemon.inspect.workerPid(boltThread)).toBeGreaterThan(1);

    // 3. RT-06: a thread that lived while its sandbox was off, whose worker is gone, is gated again at its next start.
    const cora = (
      await call<{ id: string; revision: number }>("agents.create", {
        input: AgentInput.parse({ name: "Cora", sandbox: { required: false } }),
      })
    ).id;
    const coraThread = (await call<{ sessionId: string }>("agents.openThread", { agentId: cora })).sessionId;
    await vi.waitFor(() => expect(spawnsOf(spawnLog)).toBe(2), { timeout: 30_000 });
    const view = await call<{ revision: number }>("agents.get", { agentId: cora });
    await call("agents.update", {
      agentId: cora,
      baseRevision: view.revision,
      input: AgentInput.parse({ name: "Cora", sandbox: ONE_WORD }),
    });
    killWorkerOf(t, coraThread);
    await vi.waitFor(() => expect(t.daemon.inspect.workerPid(coraThread) ?? null).toBeNull(), {
      timeout: 30_000,
    });
    expect(codeOf(await owner.client.call("sessions.prompt", { sessionId: coraThread, text: "hi" }))).toBe(
      "sandbox_unavailable",
    );
    expect(codeOf(await owner.client.call("sessions.reopen", { sessionId: coraThread }))).toBe(
      "sandbox_unavailable",
    );
    expect(t.daemon.inspect.workerPid(coraThread) ?? null).toBeNull();
    expect(spawnsOf(spawnLog)).toBe(2);

    // 4. Its isolated task fails sandbox_unavailable and its precheck is an error that ran nothing.
    const ran = join(dir, "precheck-ran");
    const task = await createTrigger(
      owner.client,
      TriggerInput.parse({
        name: "Cora alerts",
        enabled: true,
        source: { type: "webhook", format: "alertmanager" },
        execution: { agent: { agentId: cora, target: "isolated" } },
        prompt: "Handle:\n{{payload}}",
      }),
    );
    expect((await deliver(t, task.id, bearer(task.secret), alertBody("Disk", "f1"))).status).toBe(202);
    await vi.waitFor(
      () => expect(taskRowsOf(t, cora)).toMatchObject([{ state: "failed", reason: "sandbox_unavailable" }]),
      {
        timeout: 30_000,
      },
    );
    const checked = await createTrigger(
      owner.client,
      TriggerInput.parse({
        name: "Cora checked",
        enabled: true,
        source: { type: "manual" },
        execution: { agent: { agentId: cora, target: "isolated" }, precheck: `touch ${ran}` },
        prompt: "Handle:",
      }),
    );
    // A webhook runs no precheck; the owner's manual fire does (as a schedule's fire does).
    await call("automation.fire", { triggerId: checked.id });
    await vi.waitFor(
      async () =>
        expect(await journalOf(owner.client, checked.id)).toMatchObject([
          { verdict: "error", detail: "sandbox_unavailable" },
        ]),
      { timeout: 30_000 },
    );
    expect(existsSync(ran)).toBe(false);
    expect(taskRowsOf(t, cora)).toHaveLength(1);
    expect(spawnsOf(spawnLog)).toBe(2);
    expect(rows(t.home, "SELECT id FROM sessions WHERE agent_id = ?", cora)).toHaveLength(1);
  }, 120_000);
});
