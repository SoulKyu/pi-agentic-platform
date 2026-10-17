import { PapError } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { AuditPort } from "../audit/index.ts";
import { type SessionsAutomationPort, type TaskSessionPolicy } from "./automation-port.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { fakePolicyPort, initRecordOf } from "./testing/fake-policy.ts";
import { codeOf } from "./testing/helpers.ts";
import { type BedOptions, createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const build = (options?: BedOptions) =>
  createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, options);
let bed: ReturnType<typeof build>;
afterEach(() => bed.dispose());

const POLICY: TaskSessionPolicy = {
  mode: "supervised",
  tools: ["read", "grep"],
  preset: "read-only",
  tainted: true,
};
const auto = (): SessionsAutomationPort => bed.service.automation;
const task = (cwd = bed.work, ownerId = "u1") => auto().createTaskSession({ ownerId, cwd, policy: POLICY });
const ask = (id: string, toolCallId?: string) => ({
  type: "approval_request" as const,
  id,
  category: "exec" as const,
  title: "Run?",
  message: "bash: npm test",
  answers: ["deny", "session", "always", "once"] as Array<"deny" | "session" | "always" | "once">,
  tool: "bash",
  key: "a".repeat(64),
  tainted: true,
  ...(toolCallId === undefined ? {} : { toolCallId }),
});
const confirm = {
  type: "extension_ui_request" as const,
  id: "c1",
  method: "confirm",
  title: "Ok?",
  message: "m",
};
const sentTo = (index: number, type: string) => bed.spawned[index]?.sent.filter((r) => r.type === type) ?? [];

describe("createTaskSession", () => {
  it("puts the list, the mode, unattended and the taint in the first init, with the preset of the list", async () => {
    bed = build();
    const { sessionId } = await task();
    const init = initRecordOf(bed.spawned[0]);
    expect(init.policy).toMatchObject({
      approvalMode: "supervised",
      toolAllowlist: ["read", "grep"],
      unattended: true,
      taint: { tainted: true },
    });
    expect(init.tools).toEqual({ preset: "read-only", allowlist: ["read", "grep"] });
    expect(bed.store.get(sessionId)).toMatchObject({ ownerId: "u1", toolPreset: "read-only" });
  });

  it("stores the policy with the row, so a later compose reads the stored list", async () => {
    const policy = fakePolicyPort();
    bed = build({ policy });
    const { sessionId } = await task();
    expect(policy.sessionPolicy("u1", sessionId)).toMatchObject({
      mode: "supervised",
      toolAllowlist: ["read", "grep"],
      unattended: true,
      taint: { tainted: true },
    });
  });

  it("never pushes full-access to the live worker of a running task, whatever reached the stored mode (M10R153)", async () => {
    const policy = fakePolicyPort();
    bed = build({ policy });
    const { sessionId } = await task();
    policy.setMode("u1", sessionId, "full-access");
    await bed.clock.advance(0);
    const pushed = sentTo(0, "policy_update").map((r) => (r as { rules: { approvalMode: string } }).rules);
    expect(pushed.length).toBeGreaterThan(0);
    expect(pushed.map((rules) => rules.approvalMode)).not.toContain("full-access");
    // Once the task ended the owner's choice applies again.
    policy.endTaskPolicy("u1", sessionId);
    await bed.clock.advance(0);
    expect(
      (sentTo(0, "policy_update").at(-1) as { rules: { approvalMode: string } }).rules.approvalMode,
    ).toBe("full-access");
  });

  it("rolls the row back and stops the worker when the policy cannot be stored (M10R31)", async () => {
    const policy = fakePolicyPort();
    policy.failTaskPolicy();
    bed = build({ policy });
    await expect(task()).rejects.toThrow("setTaskPolicy failed");
    expect(bed.store.get("p1")).toBeUndefined();
    expect(bed.store.listByOwner("u1")).toEqual([]);
    expect(bed.spawned[0]?.stopped()).toBe(true);
    expect(bed.service.list(OWNER)).toEqual([]);
  });

  it("refuses a folder that is not a folder and a list with no tool", async () => {
    bed = build();
    expect(await codeOf(task("/nonexistent-folder-x"))).toBe("invalid_cwd");
    expect(
      await codeOf(
        auto().createTaskSession({ ownerId: "u1", cwd: bed.work, policy: { ...POLICY, tools: [] } }),
      ),
    ).toBe("bad_request");
    expect(bed.spawned).toHaveLength(0);
  });

  it("keeps one worker free for the owner: capacity, and an interactive session still opens (M10R154)", async () => {
    bed = build({ limits: { maxWorkers: 2, minFreeMemMb: 0 } });
    await bed.service.create(bed.work, OWNER);
    expect(await codeOf(task())).toBe("capacity");
    expect(bed.spawned).toHaveLength(1);
    await bed.service.create(bed.work, OWNER);
    expect(bed.spawned).toHaveLength(2);
  });

  it("reports the workers up and the cap for /metrics", async () => {
    bed = build({ limits: { maxWorkers: 3, minFreeMemMb: 0 } });
    expect(auto().workers()).toEqual({ used: 0, max: 3 });
    await bed.service.create(bed.work, OWNER);
    expect(auto().workers()).toEqual({ used: 1, max: 3 });
  });

  it("starts one automatic session at a time with two workers, and none with one", async () => {
    bed = build({ limits: { maxWorkers: 2, minFreeMemMb: 0 } });
    await task();
    expect(await codeOf(task())).toBe("capacity");
    bed.dispose();
    bed = build({ limits: { maxWorkers: 1, minFreeMemMb: 0 } });
    expect(await codeOf(task())).toBe("capacity");
  });
});

describe("prompt, abort, releaseIdle (M10R32, M10R154)", () => {
  it("prompts a live task session and answers the disposition", async () => {
    bed = build();
    const { sessionId } = await task();
    expect(await auto().prompt({ ownerId: "u1", sessionId, text: "go" })).toBe("started");
    expect(bed.spawned[0]?.requests.map((r) => r.type)).toContain("prompt");
  });

  it("drops a prompt nobody wants at the last moment: handled, and the worker is never asked (N1)", async () => {
    bed = build();
    const { sessionId } = await task();
    expect(await auto().prompt({ ownerId: "u1", sessionId, text: "go", stillWanted: () => false })).toBe(
      "handled",
    );
    expect(bed.spawned[0]?.requests.map((r) => r.type)).not.toContain("prompt");
  });

  it("refuses to reopen a cold task session when no worker would stay free", async () => {
    bed = build({ limits: { maxWorkers: 2, minFreeMemMb: 0 } });
    const { sessionId } = await task();
    expect(auto().releaseIdle("u1", sessionId)).toBe("released");
    await bed.service.create(bed.work, OWNER);
    expect(await codeOf(auto().prompt({ ownerId: "u1", sessionId, text: "again" }))).toBe("capacity");
    expect(bed.spawned).toHaveLength(2);
  });

  it("reopens a cold task session while a worker stays free", async () => {
    bed = build({ limits: { maxWorkers: 3, minFreeMemMb: 0 } });
    const { sessionId } = await task();
    auto().releaseIdle("u1", sessionId);
    expect(await auto().prompt({ ownerId: "u1", sessionId, text: "again" })).toBe("started");
    expect(bed.spawned).toHaveLength(2);
    // The new worker gets the stored list, the mode and the taint in its init.
    expect(initRecordOf(bed.spawned[1]).policy).toMatchObject({
      toolAllowlist: ["read", "grep"],
      unattended: true,
      approvalMode: "supervised",
      taint: { tainted: true },
    });
  });

  it("reaches only the owner's session", async () => {
    bed = build();
    const { sessionId } = await task();
    const other = "u2";
    expect(await codeOf(auto().prompt({ ownerId: other, sessionId, text: "x" }))).toBe("not_found");
    expect(await codeOf(auto().abort(other, sessionId))).toBe("not_found");
    expect(() => auto().releaseIdle(other, sessionId)).toThrow(new PapError("not_found"));
    expect(() => auto().answerUnattended(other, sessionId)).toThrow(new PapError("not_found"));
    expect(() => auto().archive(other, sessionId)).toThrow(new PapError("not_found"));
    expect(auto().state(other, sessionId)).toBeNull();
    expect(auto().deleteTaskSession(other, sessionId)).toBe("gone");
    expect(bed.spawned[0]?.stopped()).toBe(false);
  });

  it("aborts the run", async () => {
    bed = build();
    const { sessionId } = await task();
    await auto().abort("u1", sessionId);
    expect(bed.spawned[0]?.requests.map((r) => r.type)).toContain("abort");
  });

  it("releases an idle worker, leaves a running one, and answers cold without one", async () => {
    bed = build();
    const { sessionId } = await task();
    bed.emit(0, { type: "agent_start" });
    expect(auto().releaseIdle("u1", sessionId)).toBe("busy");
    expect(bed.spawned[0]?.stopped()).toBe(false);
    bed.emit(0, { type: "agent_settled" });
    await bed.clock.advance(300);
    expect(auto().releaseIdle("u1", sessionId)).toBe("released");
    expect(bed.spawned[0]?.stopped()).toBe(true);
    expect(auto().releaseIdle("u1", sessionId)).toBe("cold");
  });

  it("leaves a worker with a question open alone", async () => {
    bed = build();
    const { sessionId } = await task();
    bed.spawned[0]?.emit(ask("d1"));
    await bed.clock.advance(0);
    expect(auto().releaseIdle("u1", sessionId)).toBe("busy");
  });
});

describe("answerUnattended (owner m10a3, M10R159)", () => {
  it("denies the open approvals and cancels any other dialog, and counts them", async () => {
    bed = build();
    const { sessionId } = await task();
    bed.spawned[0]?.emit(ask("d1"));
    bed.spawned[0]?.emit(ask("d2"));
    bed.spawned[0]?.emit(confirm);
    await bed.clock.advance(0);
    expect(auto().answerUnattended("u1", sessionId)).toBe(3);
    expect(sentTo(0, "approval_response")).toMatchObject([{ answer: "deny" }, { answer: "deny" }]);
    expect(sentTo(0, "extension_ui_response")).toMatchObject([{ id: "c1", cancelled: true }]);
    expect(auto().answerUnattended("u1", sessionId)).toBe(0);
  });

  it("answers 0 for a session without a worker", async () => {
    bed = build();
    const { sessionId } = await task();
    auto().releaseIdle("u1", sessionId);
    expect(auto().answerUnattended("u1", sessionId)).toBe(0);
  });

  it("names the actor system on the denied call's audit row", async () => {
    const handed: Array<Parameters<AuditPort["fromWorker"]>[2]> = [];
    bed = build({
      audit: {
        append: () => {},
        reserve: () => true,
        fromWorker: (_session, _raw, context) => {
          handed.push(context);
          return null;
        },
      },
    });
    const { sessionId } = await task();
    bed.spawned[0]?.emit(ask("d1", "tc1"));
    await bed.clock.advance(0);
    auto().answerUnattended("u1", sessionId);
    bed.spawned[0]?.emit({
      type: "audit",
      entry: {
        kind: "call",
        toolCallId: "tc1",
        tool: "bash",
        category: "exec",
        decision: "denied",
        stages: [{ stage: "01", outcome: "pass" }],
        args: "npm test",
      },
    });
    await bed.clock.advance(0);
    expect(handed.map((context) => context.answeredBy)).toEqual([{ actor: "system", actorId: "automation" }]);
  });
});

describe("onAttention, state, archive, lastActivityAt", () => {
  it("reports a needsInput change once per shell flush, and a throwing listener is skipped", async () => {
    bed = build();
    const { sessionId } = await task();
    const seen: Array<[string, boolean]> = [];
    const off = auto().onAttention(() => {
      throw new Error("listener bug");
    });
    auto().onAttention((id, needs) => void seen.push([id, needs]));
    await bed.clock.advance(0);
    seen.length = 0;
    bed.spawned[0]?.emit(ask("d1"));
    bed.spawned[0]?.emit(ask("d2"));
    await bed.clock.advance(0);
    expect(seen).toEqual([[sessionId, true]]);
    auto().answerUnattended("u1", sessionId);
    await bed.clock.advance(0);
    expect(seen).toEqual([
      [sessionId, true],
      [sessionId, false],
    ]);
    off();
  });

  it("answers the state of a session, null for an unknown one", async () => {
    bed = build();
    const { sessionId } = await task();
    expect(auto().state("u1", sessionId)).toEqual({ archived: false, running: false, needsInput: false });
    bed.emit(0, { type: "agent_start" });
    bed.spawned[0]?.emit(ask("d1"));
    await bed.clock.advance(0);
    expect(auto().state("u1", sessionId)).toEqual({ archived: false, running: true, needsInput: true });
    expect(auto().state("u1", "nope")).toBeNull();
  });

  it("archives with the reversible mark, and reads the row's clock", async () => {
    bed = build();
    const { sessionId } = await task();
    const created = bed.store.get(sessionId)?.updatedAt;
    expect(auto().lastActivityAt(sessionId)).toBe(created);
    expect(auto().lastActivityAt("nope")).toBeNull();
    auto().archive("u1", sessionId);
    expect(auto().state("u1", sessionId)).toMatchObject({ archived: true });
    expect(bed.service.listArchived(OWNER, {}).sessions.map((s) => s.id)).toEqual([sessionId]);
  });
});
