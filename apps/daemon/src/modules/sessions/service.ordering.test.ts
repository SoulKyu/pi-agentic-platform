import { realpathSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import {
  addTestRule,
  fakePolicyPort,
  policyUpdatesOf,
  pushedRules,
  testRule,
} from "./testing/fake-policy.ts";
import { type BedOptions, createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const build = (options?: BedOptions) =>
  createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, options);
let bed: ReturnType<typeof build>;
const open = (options?: BedOptions): typeof bed => (bed = build(options));
afterEach(() => bed.dispose());

describe("ordered policy delivery", () => {
  it("pushes a change to a live worker before the call that made it returns (M5R7)", async () => {
    const policy = fakePolicyPort();
    open({ policy });
    await bed.service.create(bed.work, OWNER);
    const scope = realpathSync(bed.work);
    addTestRule(policy, scope, 1);
    // No await, no clock advance: the update is already on its way.
    expect(policyUpdatesOf(bed.spawned[0])).toEqual([pushedRules([testRule(1)])]);
    addTestRule(policy, scope, 2);
    expect(policyUpdatesOf(bed.spawned[0])).toEqual([
      pushedRules([testRule(1)]),
      pushedRules([testRule(1), testRule(2)]),
    ]);
  });

  it("sends the update of a revoke before a prompt handled right after it, in the same tick (carry #30)", async () => {
    const policy = fakePolicyPort();
    open({ policy });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    const scope = realpathSync(bed.work);
    policy.seed(OWNER.userId, scope, [testRule(1)]);
    // The fake keeps sent records and requests apart; one timeline shows which reached the worker first.
    const worker = bed.spawned[0];
    if (!worker) throw new Error("no worker");
    const order: string[] = [];
    const send = worker.send.bind(worker);
    const request = worker.request.bind(worker);
    worker.send = (record) => {
      order.push(record.type);
      return send(record);
    };
    worker.request = (command, timeoutMs) => {
      order.push(command.type);
      return request(command, timeoutMs);
    };
    // Two frames of one read: the second handler starts before any microtask of the first runs.
    policy.revoke(OWNER.userId, scope, testRule(1).key);
    await bed.service.prompt({ sessionId, text: "go" }, OWNER);
    expect(order).toEqual(["policy_update", "prompt"]);
  });
});
