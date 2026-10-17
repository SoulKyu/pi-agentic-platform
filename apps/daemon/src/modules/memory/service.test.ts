import { existsSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PapError } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { testCaller } from "../../testing/caller.ts";
import { createMemoryService } from "./service.ts";
import { AGENT, createMem0Layout, FACT, FACT2, type Mem0Layout } from "./testing/layout.ts";

let layout: Mem0Layout;
afterEach(() => layout.dispose());

function setup(options: { readOnly?: boolean; install?: boolean } = {}) {
  layout = createMem0Layout();
  const clock = createFakeClock();
  const audit: Array<Record<string, unknown>> = [];
  const resolved: unknown[][] = [];
  const service = createMemoryService({
    dir: options.install === false ? join(layout.root, "absent") : layout.mem0,
    clock,
    logger: silentLogger,
    readOnly: options.readOnly ?? false,
    audit: { append: (line) => void audit.push({ ...line }) },
    inbox: { resolveRef: (...args) => (resolved.push(args), true) },
    agents: {
      get: (ownerId, id) => (ownerId === "u1" && id === AGENT ? { name: "Atlas" } : null),
      list: (ownerId) => (ownerId === "u1" ? [{ id: AGENT, name: "Atlas" }] : []),
    },
  });
  const owner = testCaller();
  const code = (work: () => unknown): string => {
    try {
      work();
    } catch (error) {
      return error instanceof PapError ? error.code : `other: ${String(error)}`;
    }
    return "none";
  };
  return { service, clock, audit, resolved, owner, code };
}
const USER = { kind: "user" } as const;
const requestFiles = (name: "forget" | "save"): string[] => {
  const folder = join(layout.mem0, name);
  return existsSync(folder) ? readdirSync(folder) : [];
};
const body = (name: "forget" | "save", file: string): unknown =>
  JSON.parse(readFileSync(join(layout.mem0, name, file), "utf8"));
const seedUser = (): void =>
  void layout.json("scopes/user.json", {
    memories: [
      { id: "m1", text: "likes tea", createdAt: "2026-10-16T08:00:00Z", source: "agent" },
      { id: "m2", text: "lives in Lyon", createdAt: "2026-10-16T09:00:00Z", source: "pi-web" },
    ],
  });

describe("memory.status", () => {
  it("says pi-mem0 is not installed when the folder is missing, and fails nothing", () => {
    const t = setup({ install: false });
    expect(t.service.status(testCaller())).toEqual({
      installed: false,
      watcher: "unknown",
      checkedAt: null,
      lastCaptureError: null,
      lastCaptureAt: null,
    });
  });

  it("reports the watcher from health.json", () => {
    const t = setup();
    layout.json("health.json", { watcherAt: new Date(t.clock.now() - 60_000).toISOString() });
    expect(t.service.status(testCaller())).toEqual({
      installed: true,
      watcher: "fresh",
      checkedAt: t.clock.now() - 60_000,
      lastCaptureError: null,
      lastCaptureAt: null,
    });
    layout.json("health.json", {
      watcherAt: new Date(t.clock.now()).toISOString(),
      lastCaptureAt: "2026-10-16T07:00:00.000Z",
      lastCaptureError: "capture failed",
    });
    expect(t.service.status(testCaller())).toMatchObject({
      lastCaptureAt: "2026-10-16T07:00:00.000Z",
      lastCaptureError: "capture failed",
    });
    layout.json("health.json", { watcherAt: new Date(t.clock.now() - 121_000).toISOString() });
    expect(t.service.status(testCaller()).watcher).toBe("stale");
  });
});

describe("memory.status for a token (final review M3)", () => {
  it("keeps the capture error and time for the browser and nulls them for a token", () => {
    const t = setup();
    layout.json("health.json", {
      watcherAt: new Date(t.clock.now()).toISOString(),
      lastCaptureAt: "2026-10-16T07:00:00.000Z",
      lastCaptureError: "extraction failed on: a private fact",
    });
    expect(t.service.status(testCaller())).toMatchObject({
      lastCaptureAt: "2026-10-16T07:00:00.000Z",
      lastCaptureError: "extraction failed on: a private fact",
    });
    expect(t.service.status(testCaller({ kind: "token" }))).toEqual({
      installed: true,
      watcher: "fresh",
      checkedAt: t.clock.now(),
      lastCaptureError: null,
      lastCaptureAt: null,
    });
  });
});

describe("memory.scopes and memory.list", () => {
  it("lists the user, the projects of the index and the owner's agents", () => {
    const t = setup();
    layout.json("scopes/index.json", { projects: { p1: { label: "Pap", cwd: "/x" } } });
    expect(t.service.scopes(t.owner).scopes).toEqual([
      { scope: { kind: "user" }, label: null },
      { scope: { kind: "project", id: "p1" }, label: "Pap" },
      { scope: { kind: "agent", id: AGENT }, label: "Atlas" },
    ]);
  });

  it("lists a scope's items and the agent journal", () => {
    const t = setup();
    seedUser();
    layout.json(`agents/${AGENT}.json`, {
      memories: [],
      events: [
        {
          at: "2026-10-16T08:00:00Z",
          kind: "forget",
          id: "a1",
          text: "did a thing",
          source: "pi-web",
          scope: "agent",
        },
      ],
    });
    expect(t.service.list(t.owner, USER).items.map((each) => each.id)).toEqual(["m2", "m1"]);
    expect(t.service.list(t.owner, { kind: "agent", id: AGENT }).journal).toEqual([
      { at: "2026-10-16T08:00:00Z", kind: "forget", text: "did a thing", source: "pi-web" },
    ]);
  });

  it("answers not_found for another owner's agent and an empty list when pi-mem0 is missing", () => {
    const t = setup({ install: false });
    expect(t.code(() => t.service.list(testCaller({ userId: "u2" }), { kind: "agent", id: AGENT }))).toBe(
      "not_found",
    );
    expect(t.service.list(t.owner, USER)).toEqual({ items: [], journal: [] });
  });
});

describe("memory.forget", () => {
  it("checks every id against the snapshot before writing anything", () => {
    const t = setup();
    seedUser();
    expect(t.code(() => t.service.forget(t.owner, { scope: USER, ids: ["m1", "ghost"] }))).toBe("not_found");
    expect(requestFiles("forget")).toEqual([]);
    expect(t.audit).toEqual([]);
  });

  it("writes one request per id with the scope spelled for pi-mem0, and audits counts only", () => {
    const t = setup();
    seedUser();
    expect(t.service.forget(t.owner, { scope: USER, ids: ["m1", "m2"] })).toEqual({ requested: 2 });
    const files = requestFiles("forget");
    expect(
      files
        .map((file) => body("forget", file))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    ).toEqual([
      { memoryId: "m1", scope: "user" },
      { memoryId: "m2", scope: "user" },
    ]);
    expect(t.audit).toEqual([
      {
        ownerId: "u1",
        actor: "user",
        actorId: "test-device",
        kind: "policy",
        reason: "memory forget",
        detail: { scope: "user", op: "forget", count: 2 },
      },
    ]);
  });

  it("does not forget in another scope: an id of the user's snapshot is not found under an agent", () => {
    const t = setup();
    seedUser();
    layout.json(`agents/${AGENT}.json`, {
      memories: [{ id: "a1", text: "x", createdAt: "", source: "agent" }],
    });
    expect(
      t.code(() => t.service.forget(t.owner, { scope: { kind: "agent", id: AGENT }, ids: ["m1"] })),
    ).toBe("not_found");
    expect(requestFiles("forget")).toEqual([]);
  });

  it("is not_found for an agent that is not the owner's, bad_request for an unsafe project id", () => {
    const t = setup();
    seedUser();
    expect(
      t.code(() =>
        t.service.forget(testCaller({ userId: "u2" }), { scope: { kind: "agent", id: AGENT }, ids: ["m1"] }),
      ),
    ).toBe("not_found");
    expect(
      t.code(() => t.service.forget(t.owner, { scope: { kind: "project", id: "a..b" }, ids: ["m1"] })),
    ).toBe("bad_request");
  });
});

describe("memory.save", () => {
  it("promotes to user: the request names scope user and source pi-web", () => {
    const t = setup();
    t.service.save(t.owner, { scope: USER, text: " likes tea " });
    const [file] = requestFiles("save");
    expect(body("save", file as string)).toEqual({ scope: "user", text: "likes tea", source: "pi-web" });
    expect(t.audit).toHaveLength(1);
    expect(t.audit[0]).toMatchObject({
      reason: "memory save",
      detail: { scope: "user", op: "promote", count: 1 },
    });
  });

  it("corrects: `replaces` is checked against the same scope's snapshot", () => {
    const t = setup();
    seedUser();
    t.service.save(t.owner, { scope: USER, text: "likes coffee", replaces: "m1" });
    const [file] = requestFiles("save");
    expect(body("save", file as string)).toEqual({
      scope: "user",
      text: "likes coffee",
      replaces: "m1",
      source: "pi-web",
    });
    expect(t.audit[0]).toMatchObject({ detail: { scope: "user", op: "correct", count: 1 } });
    expect(t.code(() => t.service.save(t.owner, { scope: USER, text: "x", replaces: "ghost" }))).toBe(
      "not_found",
    );
    expect(requestFiles("save")).toHaveLength(1);
  });

  it("answers bad_request for text pi-mem0 would drop, and command_failed when it is not installed", () => {
    const t = setup();
    expect(t.code(() => t.service.save(t.owner, { scope: USER, text: "a [REDACTED] b" }))).toBe(
      "bad_request",
    );
    expect(t.code(() => t.service.save(t.owner, { scope: USER, text: '"'.repeat(4096) }))).toBe(
      "bad_request",
    );
    expect(requestFiles("save")).toEqual([]);
    const absent = setup({ install: false });
    expect(absent.code(() => absent.service.save(absent.owner, { scope: USER, text: "a" }))).toBe(
      "command_failed",
    );
  });
});

describe("memory.staged and memory.decide", () => {
  it("lists the owner's agents' facts as untrusted", () => {
    const t = setup();
    layout.fact(FACT);
    layout.fact(FACT2, { agent: "other-1a2b" });
    expect(t.service.staged(t.owner).facts).toEqual([
      {
        factId: FACT,
        agentId: AGENT,
        text: "likes tea",
        createdAt: "2026-10-16T08:00:00.000Z",
        decision: null,
        applying: false,
        untrusted: true,
      },
    ]);
  });

  it("writes the decision, closes the Inbox item and audits without the text", () => {
    const t = setup();
    layout.fact(FACT, { text: "SECRET-FACT-TEXT" });
    t.service.decide(t.owner, { factId: FACT, approved: true });
    expect(JSON.parse(readFileSync(join(layout.mem0, "staging", `${FACT}.decision.json`), "utf8"))).toEqual({
      approved: true,
    });
    expect(t.resolved).toEqual([["u1", "memory_review", FACT, "answered"]]);
    expect(t.audit[0]).toMatchObject({
      reason: "memory decide",
      detail: { scope: "staging", op: "approve", count: 1 },
    });
    expect(JSON.stringify(t.audit)).not.toContain("SECRET-FACT-TEXT");
  });

  it("is not_found for an unknown fact or another owner's agent, and closes a stale item", () => {
    const t = setup();
    expect(t.code(() => t.service.decide(t.owner, { factId: FACT, approved: true }))).toBe("not_found");
    expect(t.resolved).toEqual([["u1", "memory_review", FACT, null]]);
    layout.fact(FACT2, { agent: "other-1a2b" });
    expect(t.code(() => t.service.decide(t.owner, { factId: FACT2, approved: false }))).toBe("not_found");
    expect(existsSync(join(layout.mem0, "staging", `${FACT2}.decision.json`))).toBe(false);
  });

  it("is a conflict while pi-mem0 applies the fact", () => {
    const t = setup();
    layout.fact(FACT);
    const claim = join(layout.mem0, "staging", `${FACT}.processing`);
    writeFileSync(claim, "");
    const now = t.clock.now() / 1000;
    utimesSync(claim, now, now);
    expect(t.code(() => t.service.decide(t.owner, { factId: FACT, approved: true }))).toBe("conflict");
    expect(t.audit).toEqual([]);
  });
});

describe("staged window and claims (fix round 1)", () => {
  const idOf = (i: number): string => `${String(i).padStart(8, "0")}-e89b-42d3-a456-426614174000`;
  const stamp = (i: number): string =>
    `2026-10-16T${String(Math.floor(i / 3600)).padStart(2, "0")}:${String(Math.floor(i / 60) % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`;

  it("201 facts of another owner's agent do not hide this owner's one fact", () => {
    const t = setup();
    for (let i = 0; i < 201; i++) layout.fact(idOf(i), { agent: "other-1a2b", createdAt: stamp(i) });
    layout.fact(FACT, { createdAt: stamp(5000) });
    expect(t.service.staged(t.owner).facts.map((each) => each.factId)).toEqual([FACT]);
  });

  it("decides the 250th fact: it reads the one file, not the 200-fact window", () => {
    const t = setup();
    for (let i = 0; i < 250; i++) layout.fact(idOf(i), { createdAt: stamp(i) });
    t.service.decide(t.owner, { factId: idOf(249), approved: true });
    expect(existsSync(join(layout.mem0, "staging", `${idOf(249)}.decision.json`))).toBe(true);
  });

  it("shows a claimed fact as applying", () => {
    const t = setup();
    layout.fact(FACT);
    layout.json(`staging/${FACT}.processing`, "{}");
    expect(t.service.staged(t.owner).facts[0]).toMatchObject({ factId: FACT, applying: true });
  });

  it("allows a save without `replaces` only in the user scope", () => {
    const t = setup();
    expect(t.code(() => t.service.save(t.owner, { scope: { kind: "agent", id: AGENT }, text: "a" }))).toBe(
      "bad_request",
    );
    expect(t.code(() => t.service.save(t.owner, { scope: { kind: "project", id: "p1" }, text: "a" }))).toBe(
      "bad_request",
    );
    expect(requestFiles("save")).toEqual([]);
  });

  it("works through a linked pi-mem0 folder", () => {
    const t = setup();
    seedUser();
    const link = join(layout.root, "link");
    symlinkSync(layout.mem0, link);
    const linked = createMemoryService({
      dir: link,
      clock: t.clock,
      logger: silentLogger,
      readOnly: false,
      audit: { append: () => {} },
      inbox: { resolveRef: () => true },
      agents: { get: () => null, list: () => [] },
    });
    expect(linked.status(testCaller()).installed).toBe(true);
    expect(linked.list(t.owner, USER).items).toHaveLength(2);
  });
});

describe("who may call", () => {
  it("refuses a token on every admin method, and read-only refuses the writes", () => {
    const t = setup();
    seedUser();
    layout.fact(FACT);
    const token = testCaller({ kind: "token" });
    expect(t.code(() => t.service.scopes(token))).toBe("forbidden");
    expect(t.code(() => t.service.list(token, USER))).toBe("forbidden");
    expect(t.code(() => t.service.forget(token, { scope: USER, ids: ["m1"] }))).toBe("forbidden");
    expect(t.code(() => t.service.save(token, { scope: USER, text: "a" }))).toBe("forbidden");
    expect(t.code(() => t.service.staged(token))).toBe("forbidden");
    expect(t.code(() => t.service.decide(token, { factId: FACT, approved: true }))).toBe("forbidden");
    expect(requestFiles("forget")).toEqual([]);
    expect(requestFiles("save")).toEqual([]);
    const frozen = setup({ readOnly: true });
    expect(frozen.code(() => frozen.service.save(frozen.owner, { scope: USER, text: "a" }))).toBe(
      "read_only",
    );
  });
});
