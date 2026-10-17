import { describe, expect, it } from "vitest";
import { DaemonToWorker, InitRecord, parseWorkerRecord } from "./index.ts";

const init = { type: "init", cwd: "/w", agentDir: "/a", papHome: "/p", umask: 0o22, policy: {} };

describe("InitRecord platform, sandbox, vault and agent fields (M11R8)", () => {
  it("defaults platform to no ops and leaves the rest absent", () => {
    const parsed = InitRecord.parse(init);
    expect(parsed.platform).toEqual({ ops: [] });
    expect(parsed.sandbox).toBeUndefined();
    expect(parsed.vault).toBeUndefined();
    expect(parsed.once).toBeUndefined();
    expect(parsed.agent).toBeUndefined();
  });

  it("accepts an agent thread's init", () => {
    const record = {
      ...init,
      platform: { ops: ["agent.notify", "subagent.run"] },
      sandbox: {
        bwrap: "/usr/bin/bwrap",
        view: "host",
        home: "/p/agents/a-1a2b",
        writable: "/p/agents/a-1a2b",
        hide: ["/h"],
        network: false,
        egress: null,
      },
      vault: { GITHUB_TOKEN: "x".repeat(4096) },
      once: [{ id: "i1", name: "NPM_TOKEN", value: "v", expiresAt: 1 }],
      agent: { id: "atlas-1a2b", name: "Atlas", role: "r".repeat(8000) },
    };
    expect(InitRecord.safeParse(record).success).toBe(true);
    expect(DaemonToWorker.safeParse(record).success).toBe(true);
  });

  it("refuses an unknown op, eight ops, a duplicate op", () => {
    const ops = (value: string[]) => InitRecord.safeParse({ ...init, platform: { ops: value } }).success;
    expect(ops(["agent.root"])).toBe(false);
    expect(ops(["agent.notify", "agent.notify"])).toBe(false);
    expect(
      ops([
        "agent.notify",
        "agent.approve",
        "agent.delegate",
        "agent.remind",
        "lane.note",
        "secret.request",
        "subagent.run",
        "subagent.run",
      ]),
    ).toBe(false);
    expect(InitRecord.safeParse({ ...init, platform: { ops: [], extra: 1 } }).success).toBe(false);
  });

  it("refuses a bad vault: lower-case name, empty or 4097-character value, NUL, 51 names", () => {
    const vault = (value: Record<string, string>) => InitRecord.safeParse({ ...init, vault: value }).success;
    expect(vault({ GITHUB_TOKEN: "v" })).toBe(true);
    expect(vault({ github_token: "v" })).toBe(false);
    expect(vault({ A: "" })).toBe(false);
    expect(vault({ A: "x".repeat(4097) })).toBe(false);
    expect(vault({ A: "a\u0000b" })).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`N${i}`, "v"]));
    expect(vault(many)).toBe(false);
    expect(vault(Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`N${i}`, "v"])))).toBe(true);
  });

  it("refuses a bad one-use list and a bad agent", () => {
    const once = (value: unknown) => InitRecord.safeParse({ ...init, once: value }).success;
    expect(once([{ name: "lower", value: "v" }])).toBe(false);
    expect(once([1, 2, 3, 4].map((i) => ({ name: `N${i}`, value: "v" })))).toBe(false);
    const agent = (value: unknown) => InitRecord.safeParse({ ...init, agent: value }).success;
    expect(agent({ id: "not an id", name: "Atlas", role: "r" })).toBe(false);
    expect(agent({ id: "atlas-1a2b", name: "At las", role: "r" })).toBe(false);
    expect(agent({ id: "atlas-1a2b", name: "Atlas", role: "r".repeat(8001) })).toBe(false);
  });

  it("refuses a sandbox that is not a SandboxSpec", () => {
    expect(InitRecord.safeParse({ ...init, sandbox: { bwrap: "bwrap" } }).success).toBe(false);
  });
});

describe("vault_update and the worker's platform records", () => {
  it("accepts a vault_update from the daemon and bounds it", () => {
    const update = { type: "vault_update", vault: { A: "v" }, once: [] };
    expect(DaemonToWorker.safeParse(update).success).toBe(true);
    expect(DaemonToWorker.safeParse({ ...update, vault: { a: "v" } }).success).toBe(false);
    expect(DaemonToWorker.safeParse({ ...update, extra: 1 }).success).toBe(false);
  });

  it("routes a well-formed platform_call and platform_cancel as pap records", () => {
    const call = { type: "platform_call", id: "c1", op: "agent.notify", toolCallId: "t", args: {} };
    expect(parseWorkerRecord(call)).toEqual(call);
    expect(parseWorkerRecord({ type: "platform_cancel", id: "c1" })).toEqual({
      type: "platform_cancel",
      id: "c1",
    });
  });

  it("drops a malformed platform_call instead of forwarding it as a Pi event", () => {
    expect(
      parseWorkerRecord({ type: "platform_call", id: "c1", op: "agent.root", toolCallId: "t", args: {} }),
    ).toBeNull();
    expect(parseWorkerRecord({ type: "platform_call", id: "c1" })).toBeNull();
    expect(parseWorkerRecord({ type: "platform_cancel" })).toBeNull();
  });
});
