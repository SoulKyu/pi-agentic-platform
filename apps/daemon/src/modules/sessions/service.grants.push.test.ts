import { realpathSync } from "node:fs";
import { ALL_PERMISSIONS, type AlwaysRule, type Caller, type DaemonToWorker } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { sizeOf } from "../../kernel/json-bytes.ts";
import { fitRules } from "./grants.ts";
import { READY_TIMEOUT_MS } from "./live-session.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { fakePolicyPort } from "./testing/fake-policy.ts";
import { captureLogger } from "./testing/helpers.ts";
import { type BedOptions, createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const SECOND: Caller = { userId: "u2", permissions: new Set(ALL_PERMISSIONS) };
const build = (options?: BedOptions) =>
  createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, options);
let bed: ReturnType<typeof build>;
const open = (options?: BedOptions): typeof bed => (bed = build(options));
afterEach(() => bed.dispose());

const rule = (i: number): AlwaysRule => ({ tool: `tool-${i}`, key: i.toString(16).padStart(64, "0") });
const rules = (n: number): AlwaysRule[] => Array.from({ length: n }, (_, i) => rule(i));
const updates = (index: number): DaemonToWorker[] =>
  bed.spawned[index]?.sent.filter((record) => record.type === "policy_update") ?? [];
const update = (alwaysAllow: AlwaysRule[]) => ({
  type: "policy_update",
  rules: { profile: "interactive", approvalMode: "auto-accept-edits", alwaysAllow },
});
const initRules = (index: number) =>
  (
    bed.spawned[index]?.sent.find((record) => record.type === "init") as {
      policy: { alwaysAllow: unknown[] };
    }
  ).policy.alwaysAllow;
const add = (policy: ReturnType<typeof fakePolicyPort>, i: number, ownerId = OWNER.userId) =>
  policy.addAlways({
    ownerId,
    scope: realpathSync(bed.work),
    tool: rule(i).tool,
    key: rule(i).key,
    label: "x",
  });

describe("pushing rules to workers", () => {
  it("holds a burst of changes for a worker still starting and sends one update with the final rules after ready", async () => {
    const policy = fakePolicyPort();
    open({ policy });
    const creating = bed.service.create(bed.work, OWNER);
    // The worker exists and has its init; it has not said ready. 200 changes would be 200 records in its early queue.
    for (let i = 0; i < 200; i++) add(policy, i);
    expect(bed.spawned[0]?.sent.map((record) => record.type)).toEqual(["init"]);
    await creating;
    await bed.clock.advance(0);
    expect(bed.spawned[0]?.sent.map((record) => record.type)).toEqual(["init", "policy_update"]);
    expect(updates(0)).toEqual([update(rules(200))]);
  });

  it("sends nothing to a worker that never became ready", async () => {
    const policy = fakePolicyPort();
    open({ policy, start: () => ({ kind: "silent" }) });
    const creating = bed.service.create(bed.work, OWNER).then(
      () => "started",
      () => "failed",
    );
    add(policy, 1);
    await bed.clock.advance(READY_TIMEOUT_MS);
    expect(await creating).toBe("failed");
    expect(bed.spawned[0]?.sent.map((record) => record.type)).toEqual(["init", "shutdown"]);
  });

  it("sends a burst of changes to a live worker as one update with the final rules", async () => {
    const policy = fakePolicyPort();
    open({ policy });
    await bed.service.create(bed.work, OWNER);
    for (let i = 0; i < 200; i++) add(policy, i);
    policy.revoke(OWNER.userId, realpathSync(bed.work), rule(0).key);
    expect(updates(0)).toEqual([]);
    await bed.clock.advance(0);
    expect(updates(0)).toEqual([update(rules(200).slice(1))]);
    add(policy, 500);
    await bed.clock.advance(0);
    expect(updates(0)).toHaveLength(2);
  });

  it("gives each session its own owner's rules for its own project, at start and on a push", async () => {
    const policy = fakePolicyPort();
    open({ policy });
    const here = realpathSync(bed.work);
    policy.seed(OWNER.userId, here, [rule(1)]);
    policy.seed(SECOND.userId, here, [rule(2)]);
    policy.seed(OWNER.userId, realpathSync(bed.otherWork), [rule(3)]);
    await bed.service.create(bed.work, OWNER);
    await bed.service.create(bed.work, SECOND);
    await bed.service.create(bed.otherWork, OWNER);
    expect([initRules(0), initRules(1), initRules(2)]).toEqual([[rule(1)], [rule(2)], [rule(3)]]);
    add(policy, 4, SECOND.userId);
    await bed.clock.advance(0);
    expect([updates(0), updates(1), updates(2)]).toEqual([[], [update([rule(2), rule(4)])], []]);
  });
});

describe("the rules pushed to a worker are bounded and valid", () => {
  it("starts a worker with no allowing rule, and says so, when the list is over the 1000-rule cap", async () => {
    const { logger, lines } = captureLogger();
    const policy = fakePolicyPort();
    open({ policy, logger });
    policy.seed(OWNER.userId, realpathSync(bed.work), rules(1001));
    await bed.service.create(bed.work, OWNER);
    expect(initRules(0)).toEqual([]);
    expect(lines.filter((line) => line.msg === "policy_rules_too_large")).toHaveLength(1);
  });

  it("sends a full 1000 rules, and refuses a list over the byte budget or the rule cap", async () => {
    const policy = fakePolicyPort();
    open({ policy });
    policy.seed(OWNER.userId, realpathSync(bed.work), rules(1000));
    await bed.service.create(bed.work, OWNER);
    expect(initRules(0)).toHaveLength(1000);
    expect(fitRules(rules(1000))).toEqual(rules(1000));
    expect(fitRules(rules(3), sizeOf(rules(3)))).toEqual(rules(3));
    expect(fitRules(rules(3), sizeOf(rules(3)) - 1)).toBeNull();
    expect(fitRules(rules(1001))).toBeNull();
  });

  it("skips a stored rule outside the schema and keeps the others, at start and on a push", async () => {
    const { logger, lines } = captureLogger();
    const policy = fakePolicyPort();
    open({ policy, logger });
    const here = realpathSync(bed.work);
    const bad = { tool: "bash", key: "not-a-key" };
    policy.seed(OWNER.userId, here, [rule(1), bad, rule(2)]);
    await bed.service.create(bed.work, OWNER);
    expect(initRules(0)).toEqual([rule(1), rule(2)]);
    expect(lines.filter((line) => line.msg === "policy_rule_invalid")).toHaveLength(1);
    policy.revoke(OWNER.userId, here, "none");
    await bed.clock.advance(0);
    expect(updates(0).at(-1)).toEqual(update([rule(1), rule(2)]));
  });

  it("logs a failed read of the rules once for many workers, and stops each worker it could not tell", async () => {
    const { logger, lines } = captureLogger();
    const policy = fakePolicyPort();
    open({ policy, logger });
    await bed.service.create(bed.work, OWNER);
    await bed.service.create(bed.work, OWNER);
    policy.failReads();
    policy.revoke(OWNER.userId, realpathSync(bed.work), "none");
    await bed.clock.advance(0);
    expect(lines.filter((line) => line.msg === "policy_update_failed")).toHaveLength(1);
    expect(bed.spawned.map((worker) => worker.stopped())).toEqual([true, true]);
  });
});
