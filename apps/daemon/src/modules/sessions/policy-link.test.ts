import {
  DEFAULT_GUARD,
  DEFAULT_POLICY_SETTINGS,
  type DaemonToWorker,
  type SessionStreamEvent,
} from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { RESTRICTIVE_SETTINGS } from "../policy/index.ts";
import type { LiveSession } from "./live-session.ts";
import { createPolicyLink } from "./policy-link.ts";
import type { SessionRow } from "./store.ts";
import { fakePolicyPort, testRule } from "./testing/fake-policy.ts";
import { captureLogger } from "./testing/helpers.ts";

const ROW: SessionRow = {
  id: "s1",
  piPath: null,
  piSessionId: null,
  cwd: "/work",
  ownerId: "u1",
  name: null,
  createdAt: 0,
  updatedAt: 0,
};

interface Fakes {
  readonly session: LiveSession;
  readonly stops: () => number;
}

/** The part of a worker that the link uses: ready at once, takes records, can be stopped. */
function fakeSession(log: string[]): Fakes {
  let stops = 0;
  const session = {
    ready: Promise.resolve({}),
    status: () => "idle",
    stopping: () => false,
    send: (record: DaemonToWorker) => {
      log.push(`send:${record.type}`);
      return true;
    },
    stop: () => {
      stops++;
      return Promise.resolve();
    },
  } as unknown as LiveSession;
  return { session, stops: () => stops };
}

function build(policy = fakePolicyPort(), log: string[] = [], preset: "read-only" | null = null) {
  const { logger, lines } = captureLogger();
  const published: SessionStreamEvent[] = [];
  const audited: unknown[] = [];
  const sessions: LiveSession[] = [];
  const link = createPolicyLink({
    policy,
    audit: {
      append: () => {},
      reserve: () => true,
      fromWorker: (row, raw) => {
        audited.push([row.id, raw]);
        return null;
      },
    },
    containment: "none",
    clock: createFakeClock(),
    logger,
    hub: {
      publish: (_stream, _key, event) => {
        log.push(`publish:${(event as { kind: string }).kind}`);
        published.push(event as SessionStreamEvent);
      },
    },
    sessions: () => sessions,
    toolPreset: () => preset,
  });
  const track = async (row = ROW) => {
    const fakes = fakeSession(log);
    sessions.push(fakes.session);
    link.grants.track(fakes.session, row, link.grants.scopeOf(row.cwd));
    await fakes.session.ready;
    return fakes;
  };
  return { link, policy, lines, published, audited, track, log };
}

describe("compose", () => {
  it("builds the full rules: the mode, the fitted always rules, the owner's lists, the guard and the taint (M5R58)", () => {
    const { link, policy } = build();
    policy.seed("u1", "/work", [testRule(1), { tool: "t", key: "not-a-key" }]);
    policy.setSettings("u1", {
      defaultMode: "supervised",
      builtinDenylist: false,
      denylist: ["sudo *"],
      allowHosts: [],
      readOnlyCommands: false,
      localTools: [{ tool: "todo", source: "/x/ext/todo.ts" }],
    });
    policy.markTainted("u1", "s1");
    expect(link.compose(ROW, "/work")).toEqual({
      profile: "interactive",
      autonomy: null,
      trustedSources: [],
      hostGrants: [],
      approvalMode: "supervised",
      alwaysAllow: [testRule(1)],
      alwaysPrefixes: [],
      alwaysTools: [],
      builtinDenylist: false,
      denylist: ["sudo *"],
      allowHosts: [],
      localTools: [{ tool: "todo", source: "/x/ext/todo.ts" }],
      guard: DEFAULT_GUARD,
      taint: { tainted: true, epoch: 0 },
      readOnlyCommands: false,
      readOnlyPreset: false,
      presetTools: null,
      toolAllowlist: null,
      unattended: false,
      agentHome: null,
      agentScratch: null,
      sandbox: null,
    });
  });

  it("says the preset is read-only for a read-only session, and leaves the pin to the worker (Task 15)", () => {
    const { link } = build(fakePolicyPort(), [], "read-only");
    expect(link.compose(ROW, "/work")).toMatchObject({ readOnlyPreset: true, presetTools: null });
    expect(build().link.compose(ROW, "/work").readOnlyPreset).toBe(false);
  });

  it("uses the restrictive settings when the port cannot give the owner's, and says so", () => {
    const { link, policy, lines } = build();
    policy.failSettings();
    expect(link.compose(ROW, "/work")).toMatchObject({
      builtinDenylist: RESTRICTIVE_SETTINGS.builtinDenylist,
      denylist: RESTRICTIVE_SETTINGS.denylist,
      allowHosts: RESTRICTIVE_SETTINGS.allowHosts,
      readOnlyCommands: false,
      localTools: [],
    });
    expect(lines.filter((line) => line.msg === "policy_settings_failed")).toHaveLength(1);
  });

  it("falls back to read-only rules with the real taint when the composed rules do not parse", () => {
    const { link, policy, lines } = build();
    policy.setSettings("u1", { ...DEFAULT_POLICY_SETTINGS, denylist: ["\u0000bad"] } as never);
    policy.markTainted("u1", "s1");
    expect(link.compose(ROW, "/work")).toEqual({
      profile: "interactive",
      approvalMode: "read-only",
      taint: { tainted: true, epoch: 0 },
    });
    expect(lines.filter((line) => line.msg === "policy_rules_invalid")).toHaveLength(1);
  });
});

describe("viewOf", () => {
  it("is the default view for a session the policy module has no row for", () => {
    const { link } = build();
    expect(link.viewOf(ROW)).toEqual({
      mode: "auto-accept-edits",
      explicit: false,
      tainted: false,
      defaultMode: "auto-accept-edits",
    });
  });

  it("names the owner's default even when the session chose its own mode", () => {
    const { link, policy } = build();
    policy.setSettings("u1", { ...DEFAULT_POLICY_SETTINGS, defaultMode: "supervised" });
    policy.setMode("u1", "s1", "read-only");
    expect(link.viewOf(ROW)).toEqual({
      mode: "read-only",
      explicit: true,
      tainted: false,
      defaultMode: "supervised",
    });
  });

  it("falls back to the restrictive default when the settings cannot be read", () => {
    const { link, policy } = build();
    policy.failSettings();
    expect(link.viewOf(ROW).defaultMode).toBe(RESTRICTIVE_SETTINGS.defaultMode);
  });
});

describe("the listeners", () => {
  it("sends the worker its new rules before the policy event is published", async () => {
    const log: string[] = [];
    const { link, policy, published, track } = build(fakePolicyPort(), log);
    await track();
    policy.setMode("u1", "s1", "read-only");
    expect(log).toEqual(["send:policy_update", "publish:policy"]);
    expect(published).toEqual([
      {
        kind: "policy",
        policy: { mode: "read-only", explicit: true, tainted: false, defaultMode: "auto-accept-edits" },
      },
    ]);
    link.stop();
  });

  it("tells every tracked session of the owner its view when the settings change", async () => {
    const { link, policy, published, track } = build();
    await track();
    await track({ ...ROW, id: "s2" });
    await track({ ...ROW, id: "s3", ownerId: "u2" });
    policy.setSettings("u1", { ...DEFAULT_POLICY_SETTINGS, defaultMode: "full-access" });
    expect(published.map((event) => (event as { policy: { mode: string } }).policy.mode)).toEqual([
      "full-access",
      "full-access",
    ]);
    link.stop();
  });

  it("stops listening after stop()", async () => {
    const log: string[] = [];
    const { link, policy, track } = build(fakePolicyPort(), log);
    await track();
    link.stop();
    policy.setMode("u1", "s1", "read-only");
    expect(log).toEqual([]);
  });
});

describe("refused", () => {
  it("stops the worker and says once which session", async () => {
    const { link, lines, track } = build();
    const { session, stops } = await track();
    link.refused(ROW, session);
    link.refused(ROW, session);
    expect(stops()).toBe(2);
    expect(lines.filter((line) => line.msg === "policy_update_refused")).toEqual([
      expect.objectContaining({ sessionId: "s1" }),
    ]);
  });

  it("names every session that was refused, each said once in its window", async () => {
    const { link, lines, track } = build();
    const first = await track();
    const second = await track({ ...ROW, id: "s2" });
    link.refused(ROW, first.session);
    link.refused({ ...ROW, id: "s2" }, second.session);
    link.refused(ROW, first.session);
    expect(
      lines.filter((line) => line.msg === "policy_update_refused").map((line) => line.sessionId),
    ).toEqual(["s1", "s2"]);
  });

  it("starts its windows over once 1024 are held, so the memory stays bounded", async () => {
    const { link, lines, track } = build();
    const { session } = await track();
    link.refused(ROW, session);
    for (let n = 0; n < 1024; n++) link.refused({ ...ROW, id: `other-${n}` }, session);
    link.refused(ROW, session);
    expect(
      lines.filter((line) => line.msg === "policy_update_refused" && line.sessionId === "s1"),
    ).toHaveLength(2);
  });

  it("logs a stop that fails", async () => {
    const { link, lines, track } = build();
    const { session } = await track();
    (session as unknown as { stop(): Promise<void> }).stop = () => Promise.reject(new Error("boom"));
    link.refused(ROW, session);
    await vi.waitFor(
      () => expect(lines.filter((line) => line.msg === "worker_stop_failed")).toHaveLength(1),
      { timeout: 5_000 },
    );
  });
});

describe("audited", () => {
  it("hands a worker's audit record to the audit module", () => {
    const { link, audited } = build();
    link.audited(ROW, { kind: "call" });
    expect(audited).toEqual([["s1", { kind: "call" }]]);
  });
});
