import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentInput, type PlatformOp, type SessionType } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import type { Db } from "../../kernel/db/database.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { createPlatformPort } from "../platform/index.ts";
import { kindFacts, sessionKind } from "./session-kind.ts";
import { createSessionsService } from "./service.ts";
import { type SessionRow, createSessionsStore } from "./store.ts";
import { fakePolicyPort, initRecordOf } from "./testing/fake-policy.ts";
import { createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";
import { SESSIONS_MIGRATIONS } from "./index.ts";

const ROW: SessionRow = {
  id: "s1",
  piPath: null,
  piSessionId: null,
  cwd: "/work",
  ownerId: "u1",
  name: null,
  createdAt: 1,
  updatedAt: 1,
};
const AGENT = { agentId: "atlas-0001" };

function typeOf(
  row: SessionRow,
  options: { policy?: ReturnType<typeof fakePolicyPort>; inLane?: boolean } = {},
): SessionType {
  const policy = options.policy ?? fakePolicyPort();
  return sessionKind(row, { policy, inLane: () => options.inLane ?? false }).type;
}

describe("the facts and the type of a session row", () => {
  it("reads a plain session, a lane session and an agent thread", () => {
    expect(typeOf(ROW)).toBe("plain");
    expect(typeOf(ROW, { inLane: true })).toBe("lane");
    expect(typeOf({ ...ROW, ...AGENT, agentRole: "thread" })).toBe("agent-thread");
    expect(typeOf({ ...ROW, ...AGENT, agentRole: "task" })).toBe("agent-task");
  });

  it("reads a child with and without an agent as a child", () => {
    expect(typeOf({ ...ROW, parentSessionId: "s0" })).toBe("child");
    expect(typeOf({ ...ROW, ...AGENT, agentRole: "child", parentSessionId: "s0" })).toBe("child");
    expect(typeOf({ ...ROW, parentSessionId: "s0" }, { inLane: true })).toBe("child");
  });

  it("reads an M10 task by its closed tool list, stored or still in memory", () => {
    const policy = fakePolicyPort();
    policy.setTaskPolicy("u1", "s1", { mode: "read-only", tools: ["read"], taintedAt: null } as never);
    expect(typeOf(ROW, { policy })).toBe("task");
    expect(typeOf({ ...ROW, id: "s2" })).toBe("plain");
    const fresh = {
      ...ROW,
      id: "s3",
      task: { mode: "read-only", tools: [], preset: "read-only", tainted: false },
    };
    expect(typeOf(fresh as SessionRow)).toBe("task");
  });

  it("gives the facts the contract's type function reads", () => {
    const policy = fakePolicyPort();
    expect(kindFacts({ ...ROW, ...AGENT, agentRole: "thread" }, { policy })).toEqual({
      parentSessionId: null,
      agentRole: "thread",
      automationTask: false,
      inLane: false,
    });
  });

  it("carries the taint, the agent and the owner of the row", () => {
    const policy = fakePolicyPort();
    policy.markTainted("u1", "s1", 0);
    expect(sessionKind({ ...ROW, ...AGENT, agentRole: "thread" }, { policy })).toEqual({
      ownerId: "u1",
      type: "agent-thread",
      tainted: true,
      agentId: "atlas-0001",
      agentRole: "thread",
      parentSessionId: null,
    });
  });
});

let bed: ReturnType<typeof open>;
afterEach(() => {
  bed?.dispose();
  bed = undefined as never;
});
function open() {
  const policy = fakePolicyPort();
  const made = createServiceBed(
    { createSessionsStore, createSessionsService, loadTranscriptReader },
    { policy },
  );
  return Object.assign(made, { policy });
}
const handler = () => Promise.resolve({});
function platformWith(ops: Array<[PlatformOp, { enabled?: () => boolean }?]>) {
  const platform = createPlatformPort({
    sessions: bed.service.agent,
    audit: { append: () => {}, reserve: () => true },
    clock: bed.clock,
    logger: silentLogger,
    readOnly: false,
  });
  for (const [op, options] of ops) platform.register(op, handler as never, options);
  return platform;
}
let started = 0;
const opsOfStart = async (row: Partial<SessionRow> = {}) => {
  const id = `r${++started}`;
  // A session of an agent starts through the launch gate (M11R53): its registry, its sandbox and its home.
  let cwd = bed.work;
  if (row.agentId !== undefined) {
    cwd = join(bed.dir, "pap", "agents", row.agentId);
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    bed.service.agent.setAgentPorts({
      agents: {
        profileOf: () => ({ input: AgentInput.parse({ name: "Atlas" }), name: "Atlas", quarantined: false }),
        probe: { ensure: async () => ({ usable: true, path: "/usr/bin/bwrap" }) },
      },
    });
  }
  bed.store.insert({ ...ROW, id, cwd, ...row });
  await bed.service.reopen(id, OWNER);
  return initRecordOf(bed.spawned.at(-1)).platform?.ops;
};

describe("kindOf, read from the store", () => {
  it("answers null for a session that does not exist and the stored row's kind otherwise", () => {
    bed = open();
    expect(bed.service.agent.kindOf("nope")).toBeNull();
    bed.store.insert({ ...ROW, id: "a1", cwd: bed.work, ...AGENT, agentRole: "thread" });
    bed.store.insert({
      ...ROW,
      id: "c1",
      cwd: bed.work,
      ...AGENT,
      agentRole: "child",
      parentSessionId: "a1",
    });
    bed.policy.markTainted("u1", "a1", 0);
    expect(bed.service.agent.kindOf("a1")).toEqual({
      ownerId: "u1",
      type: "agent-thread",
      tainted: true,
      agentId: "atlas-0001",
      agentRole: "thread",
      parentSessionId: null,
      autonomous: false,
    });
    expect(bed.service.agent.kindOf("c1")).toMatchObject({
      type: "child",
      tainted: false,
      parentSessionId: "a1",
    });
  });

  it("reads a lane folder through the lane port set late", () => {
    bed = open();
    bed.store.insert({ ...ROW, id: "l1", cwd: bed.work });
    expect(bed.service.agent.kindOf("l1")?.type).toBe("plain");
    bed.service.agent.setAgentPorts({ inLane: (ownerId, cwd) => ownerId === "u1" && cwd === bed.work });
    expect(bed.service.agent.kindOf("l1")?.type).toBe("lane");
  });
});

describe("the tools a worker starts with", () => {
  it("registers no op in a plain session while subagent.run has no handler", async () => {
    bed = open();
    bed.service.agent.setAgentPorts({ platform: platformWith([["lane.note"], ["agent.notify"]]) });
    expect(await opsOfStart()).toEqual([]);
  });

  it("registers subagent.run only when its handler is there and its switch is on", async () => {
    bed = open();
    let on = false;
    bed.service.agent.setAgentPorts({ platform: platformWith([["subagent.run", { enabled: () => on }]]) });
    expect(await opsOfStart()).toEqual([]);
    on = true;
    expect(await opsOfStart()).toEqual(["subagent.run"]);
  });

  it("registers a lane session's own ops and an agent thread's, never another type's", async () => {
    bed = open();
    const all = (["lane.note", "agent.notify", "agent.delegate", "subagent.run"] as PlatformOp[]).map(
      (op) => [op] as [PlatformOp],
    );
    bed.service.agent.setAgentPorts({ platform: platformWith(all), inLane: () => true });
    expect(await opsOfStart()).toEqual(["lane.note", "subagent.run"]);
  });

  it("registers an agent thread's ops", async () => {
    bed = open();
    const all = (["lane.note", "agent.notify", "agent.delegate", "subagent.run"] as PlatformOp[]).map(
      (op) => [op] as [PlatformOp],
    );
    bed.service.agent.setAgentPorts({ platform: platformWith(all) });
    expect(await opsOfStart({ ...AGENT, agentRole: "thread" })).toEqual([
      "agent.notify",
      "agent.delegate",
      "subagent.run",
    ]);
  });

  it("registers nothing when the database is read-only", async () => {
    bed = open();
    bed.service.agent.setAgentPorts({ platform: platformWith([["subagent.run"]]) });
    expect(await opsOfStart()).toEqual(["subagent.run"]);
    Object.defineProperty(bed.store, "readOnly", { value: true });
    expect(await opsOfStart()).toEqual([]);
  });

  it("registers nothing in a child, and nothing without a platform port", async () => {
    bed = open();
    expect(await opsOfStart()).toEqual([]);
    bed.service.agent.setAgentPorts({ platform: platformWith([["subagent.run"], ["agent.notify"]]) });
    expect(await opsOfStart({ ...AGENT, agentRole: "child", parentSessionId: "p0" })).toEqual([]);
  });
});

describe("the session kind columns", () => {
  let dir: string;
  let db: Db;
  const open2 = () => {
    dir = mkdtempSync(join(tmpdir(), "pap-kinds-"));
    db = migrate({
      dbPath: join(dir, "s.db"),
      backupsDir: join(dir, "b"),
      sources: [KERNEL_MIGRATIONS, SESSIONS_MIGRATIONS],
      clock: createFakeClock(),
      logger: silentLogger,
    }).db;
  };
  afterEach(() => {
    db?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  const insert = (fields: Record<string, string | null>, id = "s1") => {
    const names = Object.keys(fields);
    db.run(
      `INSERT INTO sessions (id, cwd, owner_id, created_at, updated_at${names.map((n) => `, ${n}`).join("")})
       VALUES ($id, '/w', 'u1', 1, 1${names.map((n) => `, $${n}`).join("")})`,
      { id, ...fields },
    );
  };
  const refused = (fields: Record<string, string | null>, id = "s1") => {
    open2();
    expect(() => insert(fields, id)).toThrow(/CHECK constraint/);
  };

  it("accepts every shape the plan names", () => {
    open2();
    insert({});
    insert({ agent_id: "atlas-0001", agent_role: "thread" }, "a1");
    insert({ agent_id: "atlas-0001", agent_role: "task" }, "a2");
    insert({ parent_session_id: "a1" }, "c1");
    insert({ agent_id: "atlas-0001", agent_role: "child", parent_session_id: "a1" }, "c2");
    expect(db.all("SELECT id FROM sessions ORDER BY id")).toHaveLength(5);
  });

  it("refuses a role without an agent", () => refused({ agent_role: "thread" }));
  it("refuses an agent without a role", () => refused({ agent_id: "atlas-0001" }));
  it("refuses a role child without a parent", () => refused({ agent_id: "atlas-0001", agent_role: "child" }));
  it("refuses an agent with a parent but the role thread", () =>
    refused({ agent_id: "atlas-0001", agent_role: "thread", parent_session_id: "a1" }));
  it("refuses an agent with a parent but the role task", () =>
    refused({ agent_id: "atlas-0001", agent_role: "task", parent_session_id: "a1" }));
  it("refuses a row that is its own parent", () => refused({ parent_session_id: "s1" }));
  it("refuses an unknown role", () => refused({ agent_id: "atlas-0001", agent_role: "boss" }));
  it("refuses a short agent id", () => refused({ agent_id: "a", agent_role: "thread" }));
});
