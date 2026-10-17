import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PolicyRules, type SandboxSpec } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { createEgress, type Egress } from "../egress/index.ts";
import { captureLogger } from "./testing/helpers.ts";
import { createEgressLink, egressScopeOf, type EgressPort } from "./egress-link.ts";
import { createAgentSurface } from "./agent-surface.ts";
import { createHostGrants } from "./host-grants.ts";
import type { SessionRow } from "./store.ts";

const USABLE = { usable: true, python: "/usr/bin/python3.14", reason: null } as const;
let tmp: string;
let egress: Egress;
let port: EgressPort;
beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "egl-"));
  egress = createEgress({
    clock: createFakeClock(),
    logger: captureLogger().logger,
    papHome: tmp,
    runtimeDir: undefined,
    probe: async () => USABLE,
  });
  await egress.bootClean();
  port = Object.assign(egress, { ready: async () => {} });
});
afterEach(async () => {
  await egress.dropSession("s1");
  await egress.dropSession("s2");
  rmSync(tmp, { recursive: true, force: true });
});

const row = (extra: Partial<SessionRow> = {}): SessionRow => ({
  id: "s1",
  piPath: null,
  piSessionId: null,
  cwd: "/x",
  ownerId: "u1",
  name: null,
  createdAt: 0,
  updatedAt: 0,
  agentId: "atlas-1a2b",
  agentRole: "thread",
  ...extra,
});
const rulesOf = (extra: object = {}) =>
  PolicyRules.parse({
    profile: "agent-thread",
    approvalMode: "supervised",
    allowHosts: ["api.test"],
    trustedSources: ["docs.test"],
    sandbox: { required: true, network: true },
    ...extra,
  });

function fakeHandle() {
  let listener: (record: never) => void = () => {};
  let exit: () => void = () => {};
  const exited = new Promise<void>((resolve) => (exit = resolve));
  const sent: Array<Record<string, unknown>> = [];
  return {
    handle: {
      onRecord: (next: (record: never) => void) => ((listener = next), () => {}),
      send: (record: unknown) => (sent.push(record as Record<string, unknown>), true),
      exited: exited as never,
    },
    emit: (record: object) => listener(record as never),
    sent,
    exit,
  };
}
/** A port whose open waits for `release()`; `finished()` says the proxy has made the socket by then. */
function slowPort() {
  let release: () => void = () => {};
  let done = false;
  const slow: EgressPort = Object.assign(Object.create(port) as EgressPort, {
    openCommand: async (scope: Parameters<Egress["openCommand"]>[0]) => {
      await new Promise<void>((resolve) => (release = resolve));
      const answer = await egress.openCommand(scope);
      done = true;
      return answer;
    },
  });
  return {
    slow,
    release: () => release(),
    finished: async () => {
      await vi.waitFor(() => expect(done).toBe(true));
      for (let n = 0; n < 4; n += 1) await new Promise((resolve) => setImmediate(resolve));
    },
  };
}
const opened = (sent: Array<Record<string, unknown>>, id: string, type?: string) =>
  vi.waitFor(() => {
    const found = sent.find(
      (record) => record["id"] === id && (type === undefined || record["type"] === type),
    );
    if (!found) throw new Error("not yet");
    return found;
  });

describe("egressScopeOf (M11R243, W5-R26)", () => {
  it("is the start-time list, the sources and the thread's live grants", () => {
    const grants = createHostGrants();
    const scope = egressScopeOf(row(), rulesOf(), grants);
    expect(scope).toMatchObject({
      ownerId: "u1",
      agentId: "atlas-1a2b",
      sessionId: "s1",
      hosts: ["api.test"],
      trustedSources: ["docs.test"],
    });
    expect(scope?.grants()).toEqual([]);
    grants.note("s1", "late.test");
    expect(scope?.grants()).toEqual(["late.test"]);
  });

  it("gives a task no grants, even when the grant record holds some for its id", () => {
    const grants = createHostGrants();
    grants.note("s1", "late.test");
    expect(egressScopeOf(row({ agentRole: "task" }), rulesOf(), grants)?.grants()).toEqual([]);
  });

  it("gives a child of an agent thread the agent's list and trusted sources, and no grants (Task 29b, carry 3)", () => {
    const grants = createHostGrants();
    grants.note("s1", "late.test");
    const scope = egressScopeOf(row({ agentRole: "child" }), rulesOf(), grants);
    expect(scope).toMatchObject({ agentId: "atlas-1a2b", sessionId: "s1" });
    expect(scope?.hosts).toEqual(rulesOf().allowHosts);
    expect(scope?.trustedSources).toEqual(rulesOf().trustedSources);
    expect(scope?.grants()).toEqual([]);
  });

  it("has no scope for an owner session, a network-off agent or a sandbox-off agent", () => {
    const grants = createHostGrants();
    expect(egressScopeOf(row({ agentId: undefined, agentRole: undefined }), rulesOf(), grants)).toBeNull();
    const off = { sandbox: { required: true, network: false } };
    expect(egressScopeOf(row(), rulesOf(off), grants)).toBeNull();
    expect(egressScopeOf(row(), rulesOf({ sandbox: null }), grants)).toBeNull();
    expect(egressScopeOf(row(), rulesOf({ sandbox: { required: false, network: true } }), grants)).toBeNull();
  });

  it("fails closed on no host list: nothing is listed", () => {
    expect(egressScopeOf(row(), rulesOf({ allowHosts: null }), createHostGrants())?.hosts).toEqual([]);
  });

  it("keeps a copy: a later change of the composed rules does not widen a running worker", () => {
    const rules = rulesOf();
    const scope = egressScopeOf(row(), rules, createHostGrants());
    (rules.allowHosts as string[]).push("evil.test");
    expect(scope?.hosts).toEqual(["api.test"]);
  });
});

describe("the egress link of a worker (M11R243)", () => {
  const link = () => createEgressLink(captureLogger().logger);

  it("opens a socket in the session's folder and answers the worker", async () => {
    const w = fakeHandle();
    link()(w.handle, egressScopeOf(row(), rulesOf(), createHostGrants()), () => port);
    w.emit({ type: "egress_open", id: "call-1" });
    const answer = await opened(w.sent, "call-1");
    expect(answer).toMatchObject({ type: "egress_opened", id: "call-1", reason: null });
    expect(existsSync(String(answer["socket"]))).toBe(true);
    expect(String(answer["socket"]).startsWith(`${tmp}/run/egress/`)).toBe(true);
  });

  it("answers the report to that worker's close, and a close of an id it never opened with a truncated report", async () => {
    const w = fakeHandle();
    link()(w.handle, egressScopeOf(row(), rulesOf(), createHostGrants()), () => port);
    w.emit({ type: "egress_open", id: "call-1" });
    await opened(w.sent, "call-1");
    w.emit({ type: "egress_close", id: "call-1" });
    w.emit({ type: "egress_close", id: "never" });
    expect(await opened(w.sent, "never")).toMatchObject({
      type: "egress_report",
      truncated: true,
      hosts: [],
    });
    expect(await opened(w.sent, "call-1", "egress_report")).toMatchObject({ truncated: false, hosts: [] });
  });

  it("refuses an owner session, a network-off agent and a duplicate id", async () => {
    const owner = fakeHandle();
    link()(owner.handle, null, () => port);
    owner.emit({ type: "egress_open", id: "a" });
    expect(await opened(owner.sent, "a")).toMatchObject({ socket: null, reason: "unavailable" });
    const w = fakeHandle();
    link()(w.handle, egressScopeOf(row(), rulesOf(), createHostGrants()), () => port);
    w.emit({ type: "egress_open", id: "b" });
    await opened(w.sent, "b");
    w.emit({ type: "egress_open", id: "b" });
    await vi.waitFor(() => expect(w.sent.filter((r) => r["id"] === "b")).toHaveLength(2));
    expect(w.sent.filter((r) => r["id"] === "b")[1]).toMatchObject({ socket: null, reason: "unavailable" });
  });

  it("refuses when the egress module is not bound, and drops a malformed record", async () => {
    const w = fakeHandle();
    link()(w.handle, egressScopeOf(row(), rulesOf(), createHostGrants()), () => undefined);
    w.emit({ type: "egress_open", id: "a" });
    w.emit({ type: "egress_open", id: 5 });
    expect(await opened(w.sent, "a")).toMatchObject({ socket: null, reason: "unavailable" });
    expect(w.sent).toHaveLength(1);
  });

  it("closes one worker's commands only by that worker's own ids: it cannot close another session's command", async () => {
    const mk = link();
    const a = fakeHandle();
    const b = fakeHandle();
    mk(a.handle, egressScopeOf(row({ id: "s1" }), rulesOf(), createHostGrants()), () => port);
    mk(b.handle, egressScopeOf(row({ id: "s2" }), rulesOf(), createHostGrants()), () => port);
    a.emit({ type: "egress_open", id: "same" });
    const answer = await opened(a.sent, "same");
    // Worker b names the id a's command has: nothing of a's closes.
    b.emit({ type: "egress_close", id: "same" });
    expect(await opened(b.sent, "same")).toMatchObject({ type: "egress_report", truncated: true });
    expect(existsSync(String(answer["socket"]))).toBe(true);
  });

  it("drops the session's folder and closes its open commands when the worker exits", async () => {
    const w = fakeHandle();
    link()(w.handle, egressScopeOf(row(), rulesOf(), createHostGrants()), () => port);
    w.emit({ type: "egress_open", id: "a" });
    const socket = String((await opened(w.sent, "a"))["socket"]);
    w.exit();
    await vi.waitFor(() => expect(existsSync(dirname(socket))).toBe(false));
    expect(existsSync(socket)).toBe(false);
    expect(readdirSync(join(tmp, "run", "egress")).filter((name) => name !== "fwd.py")).toEqual([]);
  });

  it("closes a command whose open finished after the worker was gone", async () => {
    const w = fakeHandle();
    const { slow, release, finished } = slowPort();
    link()(w.handle, egressScopeOf(row(), rulesOf(), createHostGrants()), () => slow);
    w.emit({ type: "egress_open", id: "a" });
    w.exit();
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await finished();
    await vi.waitFor(() =>
      expect(readdirSync(join(tmp, "run", "egress")).filter((name) => name !== "fwd.py")).toEqual([]),
    );
  });

  it("a newer worker of the same session keeps its folder when the older one exits late", async () => {
    const mk = link();
    const older = fakeHandle();
    const newer = fakeHandle();
    mk(older.handle, egressScopeOf(row(), rulesOf(), createHostGrants()), () => port);
    mk(newer.handle, egressScopeOf(row(), rulesOf(), createHostGrants()), () => port);
    newer.emit({ type: "egress_open", id: "n" });
    const socket = String((await opened(newer.sent, "n"))["socket"]);
    older.exit();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(existsSync(socket)).toBe(true);
    newer.exit();
    await vi.waitFor(() => expect(existsSync(socket)).toBe(false));
  });

  it("a command id the old worker used again by a new worker of the session is a different command (counters restart)", async () => {
    const mk = link();
    const older = fakeHandle();
    const newer = fakeHandle();
    mk(older.handle, egressScopeOf(row(), rulesOf(), createHostGrants()), () => port);
    mk(newer.handle, egressScopeOf(row(), rulesOf(), createHostGrants()), () => port);
    older.emit({ type: "egress_open", id: "c1" });
    const oldSocket = String((await opened(older.sent, "c1"))["socket"]);
    newer.emit({ type: "egress_open", id: "c1" });
    const newSocket = String((await opened(newer.sent, "c1"))["socket"]);
    expect(newSocket).not.toBe(oldSocket);
    newer.emit({ type: "egress_close", id: "c1" });
    await opened(newer.sent, "c1", "egress_report");
    expect(existsSync(newSocket)).toBe(false);
    expect(existsSync(oldSocket)).toBe(true);
    // The stale worker closing its own c1 closes only its own.
    older.emit({ type: "egress_close", id: "c1" });
    expect(await opened(older.sent, "c1", "egress_report")).toMatchObject({ truncated: false });
    expect(existsSync(oldSocket)).toBe(false);
  });

  it("a close that arrives before its listen finished answers a cut report and leaves nothing open", async () => {
    const w = fakeHandle();
    const { slow, release, finished } = slowPort();
    link()(w.handle, egressScopeOf(row(), rulesOf(), createHostGrants()), () => slow);
    w.emit({ type: "egress_open", id: "a" });
    w.emit({ type: "egress_close", id: "a" });
    expect(await opened(w.sent, "a", "egress_report")).toMatchObject({ truncated: true, hosts: [] });
    release();
    await finished();
    // The worker is alive: its session folder stays until it exits, but the closed command left no socket in it.
    const sockets = () =>
      readdirSync(join(tmp, "run", "egress"), { recursive: true }).filter((name) =>
        String(name).endsWith(".s"),
      );
    expect(sockets()).toEqual([]);
    expect(w.sent.filter((record) => record["type"] === "egress_opened")).toEqual([]);
  });

  it("a freed slot is never answered limit: the count drops when the close starts", async () => {
    const w = fakeHandle();
    link()(w.handle, egressScopeOf(row(), rulesOf(), createHostGrants()), () => port);
    for (let n = 0; n < 8; n += 1) {
      w.emit({ type: "egress_open", id: `c${n}` });
      await opened(w.sent, `c${n}`);
    }
    w.emit({ type: "egress_open", id: "over" });
    expect(await opened(w.sent, "over")).toMatchObject({ socket: null, reason: "limit" });
    w.emit({ type: "egress_close", id: "c0" });
    w.emit({ type: "egress_open", id: "again" });
    expect(await opened(w.sent, "again")).toMatchObject({ reason: null });
  });
});

describe("an open that throws (hand-off minor 7)", () => {
  it("refuses at once instead of leaving the worker to wait out its timer, and frees the id", async () => {
    const logs = captureLogger();
    let fail = true;
    const flaky: EgressPort = Object.assign(Object.create(port) as EgressPort, {
      openCommand: async (scope: Parameters<Egress["openCommand"]>[0]) => {
        if (fail) throw new Error("listen exploded");
        return egress.openCommand(scope);
      },
    });
    const w = fakeHandle();
    createEgressLink(logs.logger)(w.handle, egressScopeOf(row(), rulesOf(), createHostGrants()), () => flaky);
    w.emit({ type: "egress_open", id: "a" });
    expect(await opened(w.sent, "a")).toMatchObject({ socket: null, reason: "unavailable" });
    expect(logs.lines.some((line) => line["msg"] === "egress_link_failed")).toBe(true);
    fail = false;
    w.emit({ type: "egress_open", id: "a" });
    await vi.waitFor(() => expect(w.sent.filter((record) => record["id"] === "a")).toHaveLength(2));
    expect(w.sent.filter((record) => record["id"] === "a")[1]).toMatchObject({ reason: null });
  });
});

describe("the launch decides: a worker whose spec has no egress gets no scope (hand-off 3)", () => {
  const surface = () =>
    createAgentSurface({
      store: { get: () => undefined, readOnly: false },
      policy: { sessionPolicy: () => ({ mode: "supervised", taint: { tainted: false, epoch: 0 } }) } as never,
      clock: createFakeClock(),
      logger: captureLogger().logger,
      worker: { papHome: tmp, agentDir: tmp },
    });
  const spec = (egress: boolean): SandboxSpec => ({
    bwrap: "/usr/bin/bwrap",
    view: "host",
    home: "/h",
    writable: "/h",
    hide: ["/var/log"],
    network: egress,
    egress: egress ? { python: "/usr/bin/python3", forwarder: "/f.py" } : null,
  });

  it("is null for a spec without egress or without a spec, whatever the rules say", () => {
    const agent = surface();
    expect(agent.egressScope(row(), rulesOf(), spec(false))).toBeNull();
    expect(agent.egressScope(row(), rulesOf(), undefined)).toBeNull();
    expect(agent.egressScope(row(), rulesOf(), spec(true))).toMatchObject({ sessionId: "s1" });
  });
});
