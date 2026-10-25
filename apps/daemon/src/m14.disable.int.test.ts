import { AgentInput, type ProjectView } from "@pap/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { drainOutboxOf } from "./testing/usage-seam.ts";
import { writeScript } from "./security/testing/agent-bed.ts";
import { rows } from "./security/testing/automation-bed.ts";
import { markOf, waitIdle } from "./security/testing/fixtures.ts";
import { rawCall, rawStep } from "./security/testing/raw-platform-extension.ts";
import { createSteppableClock, type SteppableClock } from "./security/testing/steppable-clock.ts";
import { ask, giveRows } from "./testing/member-rows.ts";
import { httpRequest } from "./testing/http-client.ts";
import {
  CANARY,
  codeOf,
  MEMBER_PASSWORD,
  type Person,
  startTwoUsers,
  type TwoUsers,
} from "./testing/two-users.ts";

// M14 J1: a member's account ends. Disable stops everything of theirs and keeps the data; delete removes the data, except the
// cost and audit records. The clock is a hand: a schedule that is due fires for the owner and, once disabled, not for the member.

const FIVE_MINUTES = 5 * 60_000;
const LIMIT_TEXT = "You have hit your ChatGPT usage limit (plus plan). Try again in ~1 min.";
const DEFAULT_SCRIPT = { steps: Array.from({ length: 12 }, () => ({ text: "ok" })) };
let clock: SteppableClock;
let u: TwoUsers;
beforeAll(async () => {
  clock = createSteppableClock();
  u = await startTwoUsers(undefined, {
    deps: { clock },
    config: { agentsMemoryMaxMb: 65_536, maxWorkers: 32 },
  });
}, 180_000);
afterAll(async () => u?.stop());

const tasksOf = (agentId: string) =>
  rows<{ state: string; origin: string }>(
    u.bed.t.home,
    "SELECT state, origin FROM tasks WHERE agent_id = ? ORDER BY created_at, id",
    agentId,
  );

/**
 * Work that is waiting for its time when the account is disabled: a reminder (a task of origin `remind` queued by the agent's
 * own tool call, due in 30 minutes) and a quota-limited run whose resume is scheduled in the outbox. Each script is read by the
 * worker that starts after it is written.
 */
async function arm(who: Person, project: ProjectView) {
  writeScript(u.bed.t, {
    steps: [
      rawStep([rawCall("agent.remind", "r1", { when: "30m", note: `${who.name} reminder` })]),
      { text: "ok" },
    ],
  });
  const agent = await ask<{ id: string }>(who, "agents.create", {
    input: AgentInput.parse({
      name: `Remind${who.name}`,
      mode: "full-access",
      preset: "full",
      sandbox: { required: true, network: true },
    }),
  });
  const { sessionId: thread } = await ask<{ sessionId: string }>(who, "agents.openThread", {
    agentId: agent.id,
  });
  await ask(who, "subscribe.session", { sessionId: thread });
  const mark = markOf(who.client);
  await ask(who, "sessions.prompt", { sessionId: thread, text: "remind me later" });
  await waitIdle(who.client, mark);
  await vi.waitFor(() => expect(tasksOf(agent.id).map((task) => task.origin)).toContain("remind"), {
    timeout: 30_000,
  });
  writeScript(u.bed.t, {
    steps: [{ stopReason: "error", errorMessage: LIMIT_TEXT }, { text: "Picked up again." }],
  });
  const { sessionId } = await ask<{ sessionId: string }>(who, "sessions.create", { cwd: project.root });
  await ask(who, "subscribe.session", { sessionId });
  await ask(who, "sessions.prompt", { sessionId, text: "the long job" });
  await vi.waitFor(
    () =>
      expect(
        rows<{ n: number }>(
          u.bed.t.home,
          "SELECT count(*) AS n FROM runs WHERE owner_id = ? AND status = 'limited'",
          who.id,
        )[0]?.n,
      ).toBe(1),
    { timeout: 30_000 },
  );
  writeScript(u.bed.t, DEFAULT_SCRIPT);
  return { remindAgent: agent.id };
}
const runsOf = (id: string, origin?: string): number =>
  rows<{ n: number }>(
    u.bed.t.home,
    `SELECT count(*) AS n FROM runs WHERE owner_id = ?${origin ? " AND origin = ?" : ""}`,
    ...(origin ? [id, origin] : [id]),
  )[0]?.n ?? 0;

describe("disabling a member", () => {
  it("stops their boxes and agents, closes their socket, refuses their token and sign-in, and no schedule starts work", async () => {
    await clock.alignTo(FIVE_MINUTES);
    // The jump may have lapsed both confirmations.
    await u.bed.t.confirmStepUp(u.owner.cookie);
    await u.member.http("/auth/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: MEMBER_PASSWORD }),
    });
    const mine = await giveRows(u, u.member);
    const control = await giveRows(u, u.owner);
    expect(await tasksOf(mine.agentId)).toHaveLength(0);
    const bearer = await u.bed.t.connectBearer(u.member.token, u.bed.t.origin);
    expect((await bearer.call("sessions.list", {})).ok).toBe(true);

    // Time passes, the schedule is due for both; the owner's fires, the member's too while the account is enabled.
    await clock.advance(FIVE_MINUTES);
    await vi.waitFor(() => expect(tasksOf(control.agentId).length).toBeGreaterThan(0), { timeout: 60_000 });
    await vi.waitFor(() => expect(tasksOf(mine.agentId).length).toBeGreaterThan(0), { timeout: 60_000 });
    // Settled: a queued task has not started its run yet, and a run row appears with the start.
    await vi.waitFor(
      () => {
        for (const id of [mine.agentId, control.agentId])
          expect(tasksOf(id).every((task) => ["done", "failed", "cancelled"].includes(task.state))).toBe(
            true,
          );
      },
      { timeout: 60_000 },
    );
    const fired = { mine: tasksOf(mine.agentId).length, control: tasksOf(control.agentId).length };
    // Right before the disable, with no clock move since, both users have a reminder due in 30 minutes and a limited run whose resume is scheduled.
    // The five minutes may have lapsed them again.
    await u.bed.t.confirmStepUp(u.owner.cookie);
    await u.member.http("/auth/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: MEMBER_PASSWORD }),
    });
    const armed = { mine: await arm(u.member, mine.project), control: await arm(u.owner, control.project) };
    const remindOf = (agentId: string) => tasksOf(agentId).find((task) => task.origin === "remind");
    expect(remindOf(armed.mine.remindAgent)?.state).toBe("queued");
    const runsBefore = rows<{ n: number }>(
      u.bed.t.home,
      "SELECT count(*) AS n FROM runs WHERE owner_id = ?",
      u.member.id,
    )[0]?.n;

    const disabled = await u.owner.call("users.setDisabled", { userId: u.member.id, disabled: true });
    expect(disabled.ok, JSON.stringify(disabled)).toBe(true);

    // The socket closes, the cookie and the token are refused, a correct password is `account_disabled`.
    expect(await Promise.race([u.member.client.closed, bearer.closed])).toBeGreaterThan(0);
    await expect(u.bed.t.connect(u.member.cookie)).rejects.toThrow();
    await expect(u.bed.t.connectBearer(u.member.token, u.bed.t.origin)).rejects.toThrow();
    const status = await httpRequest(`${u.bed.t.base}/auth/status`, { headers: { cookie: u.member.cookie } });
    expect(JSON.parse(status.body)).toMatchObject({ authenticated: false });
    const login = await httpRequest(`${u.bed.t.base}/auth/login`, {
      method: "POST",
      headers: { origin: u.bed.t.origin, "content-type": "application/json" },
      body: JSON.stringify({ username: u.member.name, password: MEMBER_PASSWORD }),
    });
    expect(JSON.parse(login.body)).toEqual({ error: { code: "account_disabled" } });

    // Their box and agent VM stop, and nothing can boot them: the launch gate refuses a disabled owner.
    expect(u.bed.vms.stopped.map((stopped) => stopped.agentId)).toContain(mine.agentId);
    expect(u.bed.vm.runtime.phase({ kind: "project", id: mine.project.id })).toBe("stopped");
    await expect(u.bed.vm.boxStack.gate({ kind: "project", id: mine.project.id })).rejects.toMatchObject({
      code: "account_disabled",
    });
    await expect(u.bed.vm.boxStack.gate({ kind: "agent", id: mine.agentId })).rejects.toMatchObject({
      code: "account_disabled",
    });

    // A live session's worker is killed after the disable: its restart is a launch, and the gate refuses it.
    const startedBefore = u.bed.vms.started.length;
    const pid = u.bed.t.daemon.inspect.workerPid(mine.sessionId);
    if (pid !== undefined) process.kill(pid, "SIGKILL");
    await vi.waitFor(() => expect(u.bed.t.daemon.inspect.workerPid(mine.sessionId)).toBeUndefined(), {
      timeout: 15_000,
    });

    // Half an hour passes: the schedule is due many times over, the reminder is due, the quota has reset. The owner's agent
    // works and the owner's reminder and resume run; the member's queued reminder, scheduled resume and schedule start nothing
    // (fire, resume, queued tasks and reminders all ask the same `paused`).
    await clock.advance(35 * 60_000);
    await drainOutboxOf(u.bed.t.home)?.();
    await vi.waitFor(() => expect(tasksOf(control.agentId).length).toBeGreaterThan(fired.control), {
      timeout: 60_000,
    });
    await vi.waitFor(
      () => {
        expect(["done", "failed"]).toContain(remindOf(armed.control.remindAgent)?.state);
        expect(runsOf(u.owner.id, "resume")).toBeGreaterThan(0);
      },
      { timeout: 60_000 },
    );
    expect(remindOf(armed.mine.remindAgent)?.state).not.toMatch(/running|done/);
    expect(runsOf(u.member.id, "remind") + runsOf(u.member.id, "resume")).toBe(0);
    // The owner's own work started VMs meanwhile; none of them is the member's box or one of the member's agents.
    const memberBoxes = new Set([mine.project.id, mine.agentId, armed.mine.remindAgent]);
    expect(u.bed.vms.started.slice(startedBefore).filter((spec) => memberBoxes.has(spec.box.id))).toEqual([]);
    expect(u.bed.vm.runtime.phase({ kind: "project", id: mine.project.id })).toBe("stopped");
    expect(tasksOf(mine.agentId)).toHaveLength(fired.mine);
    expect(
      rows<{ n: number }>(u.bed.t.home, "SELECT count(*) AS n FROM runs WHERE owner_id = ?", u.member.id)[0]
        ?.n,
    ).toBe(runsBefore);
    expect(u.bed.vm.runtime.phase({ kind: "agent", id: mine.agentId })).toBe("stopped");
    expect(JSON.stringify(await u.owner.call("sessions.list", {}))).toContain(CANARY.session);

    // Their data stays: the disabled account is listed, with its rows.
    const listed = await u.owner.call("users.list", {});
    const row = (
      listed.ok ? (listed.result as { users: Array<{ id: string; disabled: boolean }> }).users : []
    ).find((user) => user.id === u.member.id);
    expect(row?.disabled).toBe(true);
    expect(
      rows<{ n: number }>(
        u.bed.t.home,
        "SELECT count(*) AS n FROM triggers WHERE owner_id = ?",
        u.member.id,
      )[0]?.n,
    ).toBe(1);
    bearer.close();

    // Enabling needs the step-up and restores the account: the password signs in again, and the schedule fires.
    await u.bed.t.confirmStepUp(u.owner.cookie); // the clock moved: the last confirmation has lapsed
    expect(codeOf(await u.owner.call("users.setDisabled", { userId: u.member.id, disabled: false }))).toBe(
      "ok",
    );
    const again = await httpRequest(`${u.bed.t.base}/auth/login`, {
      method: "POST",
      headers: { origin: u.bed.t.origin, "content-type": "application/json" },
      body: JSON.stringify({ username: u.member.name, password: MEMBER_PASSWORD }),
    });
    expect(again.status).toBe(200);
    await clock.advance(FIVE_MINUTES);
    await vi.waitFor(() => expect(tasksOf(mine.agentId).length).toBeGreaterThan(fired.mine), {
      timeout: 60_000,
    });
  }, 240_000);
});
