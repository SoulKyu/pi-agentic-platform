import { type Caller, DEFAULT_GUARD, DEFAULT_POLICY_SETTINGS, POLICY_EXTENSION_PATH } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { fakePolicyPort, initRecordOf, policyUpdatesOf } from "./testing/fake-policy.ts";
import { captureLogger } from "./testing/helpers.ts";
import { type BedOptions, createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const SECOND: Caller = testCaller({ userId: "u2" });
const build = (options?: BedOptions) =>
  createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, options);
let bed: ReturnType<typeof build>;
const open = (options?: BedOptions): typeof bed => (bed = build(options));
afterEach(() => bed.dispose());

const initOf = (index: number) => initRecordOf(bed.spawned[index]);

describe("the policy in every worker", () => {
  it("starts a worker with the full rules: the session's mode, the owner's lists, the guard and the taint", async () => {
    const policy = fakePolicyPort();
    policy.setSettings(OWNER.userId, {
      defaultMode: "supervised",
      builtinDenylist: false,
      denylist: ["sudo *"],
      allowHosts: ["example.com"],
      readOnlyCommands: true,
    });
    open({ policy });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    expect(initOf(0).policy).toEqual({
      profile: "interactive",
      autonomy: null,
      trustedSources: [],
      hostGrants: [],
      approvalMode: "supervised",
      alwaysAllow: [],
      alwaysPrefixes: [],
      alwaysTools: [],
      builtinDenylist: false,
      denylist: ["sudo *"],
      allowHosts: ["example.com"],
      guard: DEFAULT_GUARD,
      taint: { tainted: false, epoch: 0 },
      readOnlyCommands: true,
      readOnlyPreset: false,
      presetTools: null,
      toolAllowlist: null,
      unattended: false,
      agentHome: null,
      agentScratch: null,
      sandbox: null,
    });
    const frames = await bed.subscribe(sessionId);
    policy.setMode(OWNER.userId, sessionId, "read-only");
    expect(policyUpdatesOf(bed.spawned[0]).at(-1)).toMatchObject({ rules: { approvalMode: "read-only" } });
    expect(frames.map((frame) => frame.event)).toContainEqual({
      kind: "policy",
      policy: { mode: "read-only", explicit: true, tainted: false, defaultMode: "supervised" },
    });
  });

  it("pushes a taint to the session's worker only, with the taint in the rules", async () => {
    const policy = fakePolicyPort();
    open({ policy });
    const first = await bed.service.create(bed.work, OWNER);
    await bed.service.create(bed.otherWork, OWNER);
    policy.markTainted(OWNER.userId, first.sessionId);
    expect(policyUpdatesOf(bed.spawned[0]).at(-1)).toMatchObject({
      rules: { taint: { tainted: true, epoch: 0 } },
    });
    expect(policyUpdatesOf(bed.spawned[1])).toEqual([]);
  });

  it("pushes a settings change to every worker of the owner and to no one else", async () => {
    const policy = fakePolicyPort();
    open({ policy });
    await bed.service.create(bed.work, OWNER);
    await bed.service.create(bed.otherWork, OWNER);
    await bed.service.create(bed.work, SECOND);
    policy.setSettings(OWNER.userId, { ...DEFAULT_POLICY_SETTINGS, denylist: ["x *"] });
    expect([0, 1, 2].map((i) => policyUpdatesOf(bed.spawned[i]).length)).toEqual([1, 1, 0]);
    expect(policyUpdatesOf(bed.spawned[0]).at(-1)).toMatchObject({ rules: { denylist: ["x *"] } });
  });

  it("sends read-only rules, and says so, when the composed rules are invalid (M5R58)", async () => {
    const { logger, lines } = captureLogger();
    const policy = fakePolicyPort();
    policy.setSettings(OWNER.userId, { ...DEFAULT_POLICY_SETTINGS, denylist: ["\u0000bad"] } as never);
    open({ policy, logger });
    await bed.service.create(bed.work, OWNER);
    expect(initOf(0).policy).toEqual({
      profile: "interactive",
      approvalMode: "read-only",
      taint: { tainted: false, epoch: 0 },
    });
    expect(lines.filter((line) => line.msg === "policy_rules_invalid")).toHaveLength(1);
  });

  it("carries the policy view in the snapshot of a cold session", async () => {
    const policy = fakePolicyPort();
    open({ policy });
    const now = bed.clock.now();
    bed.store.insert({
      id: "cold1",
      piPath: null,
      piSessionId: null,
      cwd: bed.work,
      ownerId: OWNER.userId,
      name: null,
      createdAt: now,
      updatedAt: now,
    });
    policy.markTainted(OWNER.userId, "cold1");
    const frames = await bed.subscribe("cold1");
    expect(frames[0]?.event).toMatchObject({
      kind: "snapshot",
      status: "cold",
      policy: { mode: "auto-accept-edits", explicit: false, tainted: true, defaultMode: "auto-accept-edits" },
    });
  });

  it("stops a worker that refused a policy update, so the next prompt starts one with composed rules (M5R11)", async () => {
    const { logger, lines } = captureLogger();
    open({ policy: fakePolicyPort(), logger });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    bed.spawned[0]?.emit({
      type: "extension_error",
      extensionPath: POLICY_EXTENSION_PATH,
      event: "policy_update",
      error: "invalid policy rules",
    });
    await vi.waitFor(() => expect(bed.spawned[0]?.stopped()).toBe(true), { timeout: 5_000 });
    expect(lines.filter((line) => line.msg === "policy_update_refused")).toEqual([
      expect.objectContaining({ sessionId }),
    ]);
    await bed.service.prompt({ sessionId, text: "again" }, OWNER);
    expect(bed.spawned).toHaveLength(2);
  });

  it.each([
    ["another extension", { extensionPath: "/ext/other.ts", event: "policy_update" }],
    ["another event", { extensionPath: POLICY_EXTENSION_PATH, event: "tool_call" }],
  ])("keeps the worker when the error comes from %s", async (_name, source) => {
    open({ policy: fakePolicyPort() });
    await bed.service.create(bed.work, OWNER);
    bed.spawned[0]?.emit({ type: "extension_error", ...source, error: "x" });
    await bed.clock.advance(0);
    expect(bed.spawned[0]?.stopped()).toBe(false);
  });
});
