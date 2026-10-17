import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AgentInput, type VaultUpdateRecord } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionsAgentDeps } from "./agent-gate.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { type BedOptions, createServiceBed } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const ATLAS = "atlas-1a2b";
const TASK = "0a1b2c3d-0000-4000-8000-0123456789ab";
const VALUE = "once-value-9f3c1d7e";
const build = (options?: BedOptions) =>
  createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, options);
let bed: ReturnType<typeof build>;
const EXP = 1_800_000_000_000;
let waiting: Array<{ id: string; name: string; value: string; expiresAt: number }> = [];
const used = vi.fn();
afterEach(() => bed.dispose());

function setup(sandboxRequired = true, options?: BedOptions, extra: Partial<SessionsAgentDeps> = {}): void {
  waiting = [];
  used.mockReset();
  bed = build(options);
  mkdirSync(join(bed.dir, "pap", "agents", ATLAS), { recursive: true, mode: 0o700 });
  bed.service.agent.setAgentPorts({
    agents: {
      profileOf: (ownerId, agentId) =>
        ownerId === "u1" && agentId === ATLAS
          ? {
              input: AgentInput.parse({ name: "A", sandbox: { required: sandboxRequired, network: false } }),
              name: "A",
              quarantined: false,
            }
          : null,
      vaultOf: () => ({}),
      onceOf: () => waiting.map((each) => ({ ...each })),
      onceUsed: used,
      probe: { ensure: async () => ({ usable: true, path: "/usr/bin/bwrap" }) },
      ...extra,
    },
  });
}
const thread = () =>
  bed.service.agentSessions.createAgentSession({ ownerId: "u1", agentId: ATLAS, role: "thread" });
const updates = (index: number) =>
  bed.spawned[index]?.sent.filter((record) => record.type === "vault_update") ?? [];

describe("sendToAgent to one session", () => {
  it("reaches only the named session of the agent, never another worker of it", async () => {
    setup();
    const { sessionId } = await thread();
    const scratch = join(bed.dir, "pap", "agents", ".runs", ATLAS, TASK);
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    await bed.service.agentSessions.createAgentSession({
      ownerId: "u1",
      agentId: ATLAS,
      role: "task",
      scratch,
      task: { mode: "supervised", tools: ["bash"], preset: "full", tainted: false },
    });
    const record: VaultUpdateRecord = {
      type: "vault_update",
      vault: {},
      once: [{ id: "id-API_TOKEN", name: "API_TOKEN", value: VALUE, expiresAt: EXP }],
    };
    expect(bed.service.agentSessions.sendToAgent("u1", ATLAS, record, sessionId)).toBe(1);
    expect(updates(0)).toEqual([record]);
    expect(updates(1)).toEqual([]);
    expect(bed.service.agentSessions.sendToAgent("u1", ATLAS, record, "nobody")).toBe(0);
    expect(bed.service.agentSessions.sendToAgent("u2", ATLAS, record, sessionId)).toBe(0);
  });
});

describe("every record carries the session's full once list (W5-R37)", () => {
  it("an untargeted send (a vault change) gives each session its own list, so it never empties a worker's set", async () => {
    setup();
    waiting = [{ id: "id-API_TOKEN", name: "API_TOKEN", value: VALUE, expiresAt: EXP }];
    const { sessionId } = await thread();
    const plain: VaultUpdateRecord = {
      type: "vault_update",
      vault: { SAVED_NAME: "saved-value-123" },
      once: [],
    };
    expect(bed.service.agentSessions.sendToAgent("u1", ATLAS, plain)).toBe(1);
    expect(updates(0)).toEqual([
      { ...plain, once: [{ id: "id-API_TOKEN", name: "API_TOKEN", value: VALUE, expiresAt: EXP }] },
    ]);
    waiting = [];
    expect(bed.service.agentSessions.sendToAgent("u1", ATLAS, plain)).toBe(1);
    expect(updates(0).at(-1)).toEqual(plain);
    expect(sessionId).toBeTruthy();
  });
});

describe("sandboxed (M11R103)", () => {
  it("is true for a worker that started with the sandbox on, for its owner only", async () => {
    setup();
    const { sessionId } = await thread();
    expect(bed.service.agentSessions.sandboxed("u1", sessionId)).toBe(true);
    expect(bed.service.agentSessions.sandboxed("u2", sessionId)).toBe(false);
    expect(bed.service.agentSessions.sandboxed("u1", "nobody")).toBe(false);
  });

  it("is false when the agent's sandbox is off", async () => {
    setup(false);
    const { sessionId } = await thread();
    expect(bed.service.agentSessions.sandboxed("u1", sessionId)).toBe(false);
  });
});

describe("init.once (M11R105)", () => {
  it("starts a sandboxed thread with the values that wait for its session", async () => {
    setup();
    waiting = [{ id: "id-API_TOKEN", name: "API_TOKEN", value: VALUE, expiresAt: EXP }];
    await thread();
    const init = bed.spawned[0]?.sent.find((record) => record.type === "init");
    expect(init).toMatchObject({
      once: [{ id: "id-API_TOKEN", name: "API_TOKEN", value: VALUE, expiresAt: EXP }],
    });
  });

  it("starts without a once field when nothing waits", async () => {
    setup();
    await thread();
    const init = bed.spawned[0]?.sent.find((record) => record.type === "init") as Record<string, unknown>;
    expect(init).not.toHaveProperty("once");
  });

  it("never gives a value to a worker without the sandbox", async () => {
    setup(false);
    waiting = [{ id: "id-API_TOKEN", name: "API_TOKEN", value: VALUE, expiresAt: EXP }];
    await thread();
    const init = bed.spawned[0]?.sent.find((record) => record.type === "init") as Record<string, unknown>;
    expect(init).not.toHaveProperty("once");
    expect(JSON.stringify(init)).not.toContain(VALUE);
  });
});

describe("a value that lands while the worker boots", () => {
  const ready = (index: number) =>
    bed.spawned[index]?.emit({
      type: "ready",
      sessionId: `pi-${index}`,
      sessionFile: join(bed.dir, `pi-${index}.jsonl`),
      piVersion: "1.1.0",
      leafId: null,
      sessionName: null,
    });

  it("reaches the worker in the update that levels it: the whole current list (W5-R37)", async () => {
    setup(true, { start: () => ({ kind: "silent" }) });
    waiting = [{ id: "id-OLD_NAME", name: "OLD_NAME", value: "old-value-123456", expiresAt: EXP }];
    const starting = thread();
    await vi.waitFor(() => expect(bed.spawned).toHaveLength(1), { timeout: 5000 });
    waiting = [
      ...waiting,
      { id: "id-NEW_NAME", name: "NEW_NAME", value: "new-value-123456", expiresAt: EXP },
    ];
    ready(0);
    await starting;
    expect(updates(0)).toEqual([
      {
        type: "vault_update",
        vault: {},
        once: [
          { id: "id-OLD_NAME", name: "OLD_NAME", value: "old-value-123456", expiresAt: EXP },
          { id: "id-NEW_NAME", name: "NEW_NAME", value: "new-value-123456", expiresAt: EXP },
        ],
      },
    ]);
  });

  it("sends nothing when init carried everything", async () => {
    setup(true, { start: () => ({ kind: "silent" }) });
    waiting = [{ id: "id-OLD_NAME", name: "OLD_NAME", value: "old-value-123456", expiresAt: EXP }];
    const starting = thread();
    await vi.waitFor(() => expect(bed.spawned).toHaveLength(1), { timeout: 5000 });
    ready(0);
    await starting;
    expect(updates(0)).toEqual([]);
  });
});

describe("secret_used from a worker", () => {
  it("tells the agents module which session used which name, and only for its own session", async () => {
    setup();
    const { sessionId } = await thread();
    bed.spawned[0]?.emit({ type: "secret_used", name: "API_TOKEN", id: "i1" });
    expect(used).toHaveBeenCalledExactlyOnceWith(sessionId, "i1");
  });

  it("ignores a name that is not a vault name and a record with extra keys", async () => {
    setup();
    await thread();
    bed.spawned[0]?.emit({ type: "secret_used", name: "PATH", id: "i1" });
    bed.spawned[0]?.emit({ type: "secret_used", name: "API_TOKEN", id: "i1", sessionId: "other" } as never);
    expect(used).not.toHaveBeenCalled();
  });

  it("logs a handler that throws and keeps the session running", async () => {
    setup(true, undefined, {
      onceUsed: () => {
        throw new Error(`boom ${VALUE}`);
      },
    });
    await thread();
    expect(() => bed.spawned[0]?.emit({ type: "secret_used", name: "API_TOKEN", id: "i1" })).not.toThrow();
    expect(bed.spawned[0]?.stopped()).toBe(false);
  });
});
