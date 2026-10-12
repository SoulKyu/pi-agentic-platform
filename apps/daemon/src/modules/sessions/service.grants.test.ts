import { realpathSync } from "node:fs";
import { type AlwaysRule, type DaemonToWorker, PolicyRules } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GRANT_NOTICE_EVERY_MS } from "./grants.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { captureLogger } from "./testing/helpers.ts";
import { fakePolicyPort } from "./testing/fake-policy.ts";
import { type BedOptions, createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const KEY = "a".repeat(64);
const OTHER_KEY = "b".repeat(64);
const build = (options?: BedOptions) =>
  createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, options);
let bed: ReturnType<typeof build>;
const open = (options?: BedOptions): typeof bed => (bed = build(options));
afterEach(() => bed.dispose());

const ask = (id: string, key = KEY) => ({
  type: "approval_request" as const,
  id,
  category: "exec" as const,
  title: "Run?",
  message: "bash: npm test",
  answers: ["deny", "session", "always", "once"] as Array<"deny" | "session" | "always" | "once">,
  tool: "bash",
  key,
  tainted: false,
});
const updates = (index: number): DaemonToWorker[] =>
  bed.spawned[index]?.sent.filter((record) => record.type === "policy_update") ?? [];
const rulesOf = (alwaysAllow: AlwaysRule[]) => ({
  type: "policy_update",
  rules: PolicyRules.parse({ profile: "interactive", approvalMode: "auto-accept-edits", alwaysAllow }),
});
const always = async (index: number, sessionId: string, id: string, key = KEY) => {
  bed.spawned[index]?.emit(ask(id, key));
  await bed.clock.advance(0);
  bed.service.respondDialog({ sessionId, dialogId: id, response: { answer: "always" } }, OWNER);
  await bed.clock.advance(0);
};
const notices = (frames: Array<{ event: unknown }>) =>
  frames.map((frame) => frame.event as { kind: string }).filter((event) => event.kind === "notice");

describe("always and session answers", () => {
  it("persists an always answer and pushes the project's rules to its live workers only", async () => {
    const policy = fakePolicyPort();
    open({ policy });
    const first = await bed.service.create(bed.work, OWNER);
    await bed.service.create(bed.work, OWNER);
    await bed.service.create(bed.otherWork, OWNER);
    await always(0, first.sessionId, "a1");
    expect(policy.added).toEqual([
      {
        ownerId: OWNER.userId,
        scope: realpathSync(bed.work),
        tool: "bash",
        key: KEY,
        label: "bash: npm test",
      },
    ]);
    expect(bed.spawned[0]?.sent.find((r) => r.type === "approval_response")).toMatchObject({
      answer: "always",
    });
    const pushed = rulesOf([{ tool: "bash", key: KEY }]);
    // The worker that took the answer hears it too: its provisional grant ends at the update, the rule takes over.
    expect(updates(0)).toEqual([pushed]);
    expect(updates(1)).toEqual([pushed]);
    expect(updates(2)).toEqual([]);
  });

  it("does not persist a once, session or deny answer, and pushes nothing", async () => {
    const policy = fakePolicyPort();
    open({ policy });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    for (const answer of ["session", "once", "deny"] as const) {
      bed.spawned[0]?.emit(ask(`a-${answer}`));
      await bed.clock.advance(0);
      bed.service.respondDialog({ sessionId, dialogId: `a-${answer}`, response: { answer } }, OWNER);
    }
    expect(policy.added).toEqual([]);
    expect(updates(0)).toEqual([]);
  });

  it("starts a worker with its project's always rules", async () => {
    const policy = fakePolicyPort();
    open({ policy });
    policy.seed(OWNER.userId, realpathSync(bed.work), [{ tool: "bash", key: KEY }]);
    await bed.service.create(bed.work, OWNER);
    expect(bed.spawned[0]?.sent.find((record) => record.type === "init")).toMatchObject({
      policy: { alwaysAllow: [{ tool: "bash", key: KEY }] },
    });
  });

  it("pushes a revoke to the live worker: the update carries the rules that remain", async () => {
    const policy = fakePolicyPort();
    open({ policy });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    await always(0, sessionId, "a1");
    await always(0, sessionId, "a2", OTHER_KEY);
    policy.revoke(OWNER.userId, realpathSync(bed.work), KEY);
    await bed.clock.advance(0);
    expect(updates(0).at(-1)).toEqual(rulesOf([{ tool: "bash", key: OTHER_KEY }]));
    policy.revoke(OWNER.userId, realpathSync(bed.work), OTHER_KEY);
    await bed.clock.advance(0);
    expect(updates(0).at(-1)).toEqual(rulesOf([]));
  });

  it("does not push another owner's change to a worker", async () => {
    const policy = fakePolicyPort();
    open({ policy });
    await bed.service.create(bed.work, OWNER);
    policy.revoke("u2", realpathSync(bed.work), KEY);
    expect(updates(0)).toEqual([]);
  });

  it("stops telling a worker once it has exited, and stops listening when the module stops", async () => {
    const policy = fakePolicyPort();
    open({ policy });
    await bed.service.create(bed.work, OWNER);
    expect(policy.listenerCount()).toBe(1);
    await bed.service.shutdownAll();
    expect(policy.listenerCount()).toBe(0);
    policy.revoke(OWNER.userId, realpathSync(bed.work), KEY);
    expect(updates(0)).toEqual([]);
  });

  it("does not complain about, or stop, a worker that exited just before its update was sent", async () => {
    const { logger, lines } = captureLogger();
    const policy = fakePolicyPort();
    open({ policy, logger });
    await bed.service.create(bed.work, OWNER);
    const worker = bed.spawned[0];
    if (!worker) throw new Error("no worker");
    const stop = vi.spyOn(worker, "stop");
    // The exit is settled first (its listeners run before the queued update does), the change comes after.
    worker.crash({ code: 1, signal: null, cause: "exit_code" });
    policy.revoke(OWNER.userId, realpathSync(bed.work), KEY);
    await bed.clock.advance(0);
    expect(updates(0)).toEqual([]);
    expect(stop).not.toHaveBeenCalled();
    expect(lines.filter((line) => line.msg === "policy_update_not_sent")).toEqual([]);
  });

  it("stops a worker that could not be told of a change: it must not keep a revoked rule", async () => {
    const { logger, lines } = captureLogger();
    const policy = fakePolicyPort();
    open({ policy, logger });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    const worker = bed.spawned[0];
    if (!worker) throw new Error("no worker");
    worker.send = () => false;
    policy.revoke(OWNER.userId, realpathSync(bed.work), KEY);
    await bed.clock.advance(0);
    expect(worker.stopped()).toBe(true);
    expect(lines.filter((line) => line.msg === "policy_update_not_sent")).toHaveLength(1);
    expect(bed.service.list(OWNER).find((row) => row.id === sessionId)?.status).toBe("cold");
  });
});

describe("an always rule that cannot be saved", () => {
  it("says so when the project's always rules are full, at most once per window, and keeps the answer for the session", async () => {
    const policy = fakePolicyPort({ full: true });
    open({ policy });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    const frames = await bed.subscribe(sessionId);
    await always(0, sessionId, "a1");
    expect(notices(frames)).toEqual([
      {
        kind: "notice",
        level: "warning",
        text: "This project already has 1000 always-allowed calls: this one is allowed until this project's rules change.",
        code: "rules_full",
        params: { max: "1000" },
      },
    ]);
    // The worker still got the answer: the call it asked about runs.
    expect(bed.spawned[0]?.sent.find((record) => record.type === "approval_response")).toMatchObject({
      answer: "always",
    });
    await always(0, sessionId, "a2");
    expect(notices(frames)).toHaveLength(1);
    await bed.clock.advance(GRANT_NOTICE_EVERY_MS);
    await always(0, sessionId, "a3");
    expect(notices(frames)).toHaveLength(2);
    expect(updates(0)).toEqual([]);
  });

  it("fails closed when addAlways throws: no rule, the call proceeds, the failure is logged once with a stable code", async () => {
    const { logger, lines } = captureLogger();
    const policy = fakePolicyPort({ throws: true });
    open({ policy, logger });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    const frames = await bed.subscribe(sessionId);
    await always(0, sessionId, "a1");
    await always(0, sessionId, "a2", OTHER_KEY);
    expect(policy.added).toEqual([]);
    expect(updates(0)).toEqual([]);
    expect(bed.spawned[0]?.sent.filter((record) => record.type === "approval_response")).toHaveLength(2);
    const logged = lines.filter((line) => line.msg === "always_rule_not_saved");
    expect(logged).toHaveLength(1);
    expect(notices(frames)).toEqual([
      {
        kind: "notice",
        level: "warning",
        text: "This call is allowed until this project's rules change: its always rule could not be saved.",
        code: "rules_not_saved",
      },
    ]);
  });
});
