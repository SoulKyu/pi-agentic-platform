import {
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
  utimesSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createStagedCache,
  isInstalled,
  listStaged,
  mem0Dir,
  MEM0_LIMITS,
  readStagedFact,
  readSmall,
  requestForget,
  requestSave,
  requestScope,
  snapshotPath,
  writeDecision,
} from "./mem0-files.ts";
import { AGENT, createMem0Layout, FACT, FACT2, type Mem0Layout } from "./testing/layout.ts";

let layout: Mem0Layout;
afterEach(() => layout.dispose());
const setup = (): Mem0Layout => (layout = createMem0Layout());
const mode = (path: string): number => statSync(path).mode & 0o777;
const files = (dir: string): string[] => readdirSync(dir).sort();

describe("scopes and snapshot paths", () => {
  it("spells the scopes as pi-mem0 does and refuses ids it would refuse", () => {
    setup();
    expect(requestScope({ kind: "user" })).toBe("user");
    expect(requestScope({ kind: "project", id: "my.proj-1" })).toBe("project:my.proj-1");
    expect(requestScope({ kind: "agent", id: AGENT })).toBe(`agent:${AGENT}`);
    for (const id of ["a..b", "a/b", "", "x".repeat(129)])
      expect(requestScope({ kind: "project", id }), id).toBeNull();
    for (const id of ["Atlas-1a2b", "../x", "a", "-atlas1", "x".repeat(49)])
      expect(requestScope({ kind: "agent", id }), id).toBeNull();
  });

  it("places the snapshots inside the folder, and nowhere for a bad id", () => {
    setup();
    expect(snapshotPath("/m", { kind: "user" })).toBe("/m/scopes/user.json");
    expect(snapshotPath("/m", { kind: "project", id: "p1" })).toBe("/m/scopes/project-p1.json");
    expect(snapshotPath("/m", { kind: "agent", id: AGENT })).toBe(`/m/agents/${AGENT}.json`);
    expect(snapshotPath("/m", { kind: "project", id: "../x" })).toBeNull();
    expect(snapshotPath("/m", { kind: "agent", id: "../x" })).toBeNull();
  });
});

describe("readSmall", () => {
  it("reads a regular file and refuses a link, a folder, a missing file and an oversized one", () => {
    setup();
    const ok = layout.json("a.json", "hello");
    expect(readSmall(ok, 100)).toBe("hello");
    expect(readSmall(ok, 4)).toBeNull();
    expect(readSmall(join(layout.mem0, "missing"), 100)).toBeNull();
    expect(readSmall(layout.mem0, 100)).toBeNull();
    symlinkSync(ok, join(layout.mem0, "link.json"));
    expect(readSmall(join(layout.mem0, "link.json"), 100)).toBeNull();
  });
});

describe("forget request", () => {
  it("writes <uuid>.json (0600) in forget/ (0700) with the body, and leaves no temp file", () => {
    setup();
    const id = requestForget(layout.mem0, { kind: "user" }, "m:1");
    const folder = join(layout.mem0, "forget");
    expect(files(folder)).toEqual([`${id}.json`]);
    expect(JSON.parse(readFileSync(join(folder, `${id}.json`), "utf8"))).toEqual({
      memoryId: "m:1",
      scope: "user",
    });
    expect(mode(join(folder, `${id}.json`))).toBe(0o600);
    expect(mode(folder)).toBe(0o700);
  });

  it("refuses bad scope ids and memory ids before writing anything", () => {
    setup();
    expect(() => requestForget(layout.mem0, { kind: "agent", id: "../x" }, "m1")).toThrow(
      "bad forget request",
    );
    expect(() => requestForget(layout.mem0, { kind: "project", id: "a..b" }, "m1")).toThrow(
      "bad forget request",
    );
    expect(() => requestForget(layout.mem0, { kind: "user" }, "../m1")).toThrow("bad forget request");
    expect(() => requestForget(layout.mem0, { kind: "user" }, "")).toThrow("bad forget request");
    expect(readdirSync(layout.mem0)).toEqual([]);
  });

  it("accepts the longest ids and refuses a linked forget/ folder", () => {
    setup();
    expect(() =>
      requestForget(layout.mem0, { kind: "project", id: "p".repeat(128) }, "m".repeat(128)),
    ).not.toThrow();
    const second = createMem0Layout();
    try {
      symlinkSync(layout.dir("elsewhere"), join(second.mem0, "forget"));
      expect(() => requestForget(second.mem0, { kind: "user" }, "m1")).toThrow("not a directory");
      expect(readdirSync(join(layout.mem0, "elsewhere"))).toEqual([]);
    } finally {
      second.dispose();
    }
  });
});

describe("save request", () => {
  it("writes the body with source pi-web, trimmed, and `replaces` only for a correction", () => {
    setup();
    const promote = requestSave(layout.mem0, { kind: "user" }, "  likes tea \n");
    const correct = requestSave(layout.mem0, { kind: "agent", id: AGENT }, "likes coffee", "m-1");
    const read = (id: string): unknown =>
      JSON.parse(readFileSync(join(layout.mem0, "save", `${id}.json`), "utf8"));
    expect(read(promote)).toEqual({ scope: "user", text: "likes tea", source: "pi-web" });
    expect(read(correct)).toEqual({
      scope: `agent:${AGENT}`,
      text: "likes coffee",
      replaces: "m-1",
      source: "pi-web",
    });
    expect(mode(join(layout.mem0, "save", `${promote}.json`))).toBe(0o600);
    expect(files(join(layout.mem0, "save"))).toHaveLength(2);
  });

  it("refuses [REDACTED], empty text, 4 097 characters and an escaped body over 8 KB", () => {
    setup();
    const user = { kind: "user" } as const;
    expect(() => requestSave(layout.mem0, user, "a [REDACTED] b")).toThrow("bad save request");
    expect(() => requestSave(layout.mem0, user, "  \n ")).toThrow("bad save request");
    expect(() => requestSave(layout.mem0, user, "x".repeat(MEM0_LIMITS.textChars + 1))).toThrow(
      "bad save request",
    );
    expect(() => requestSave(layout.mem0, user, "x".repeat(MEM0_LIMITS.textChars))).not.toThrow();
    // 4096 quotes escape to 8192 bytes of text, so the whole body is over 8 KB.
    expect(() => requestSave(layout.mem0, user, '"'.repeat(MEM0_LIMITS.textChars))).toThrow(
      "request too large",
    );
    expect(() => requestSave(layout.mem0, { kind: "agent", id: "../x" }, "a")).toThrow("bad save request");
    expect(() => requestSave(layout.mem0, user, "a", "../x")).toThrow("bad save request");
    expect(files(join(layout.mem0, "save"))).toHaveLength(1);
  });
});

describe("staging", () => {
  it("lists a valid fact with no decision, and drops bad ones", () => {
    setup();
    layout.fact(FACT);
    layout.fact(FACT2, { id: FACT });
    layout.json("staging/not-a-fact.json", "{}");
    expect(listStaged(layout.mem0, { now: Date.now() })).toEqual([
      {
        id: FACT,
        agent: AGENT,
        text: "likes tea",
        createdAt: "2026-10-16T08:00:00.000Z",
        decision: null,
        applying: false,
      },
    ]);
  });

  it("skips a symlinked fact, a fact of a bad agent id and a fact with a wrong shape", () => {
    setup();
    const real = layout.json("outside.json", {
      id: FACT,
      agent: AGENT,
      text: "t",
      sourceSession: "s",
      createdAt: "x",
    });
    layout.dir("staging");
    symlinkSync(real, join(layout.mem0, "staging", `${FACT}.json`));
    layout.fact(FACT2, { agent: "../x" });
    expect(listStaged(layout.mem0, { now: Date.now() })).toEqual([]);
    layout.fact("323e4567-e89b-42d3-a456-426614174000", { text: 5 });
    expect(listStaged(layout.mem0, { now: Date.now() })).toEqual([]);
  });

  it("ignores a staging/ that is a link", () => {
    setup();
    const other = createMem0Layout();
    try {
      other.fact(FACT);
      symlinkSync(join(other.mem0, "staging"), join(layout.mem0, "staging"));
      expect(listStaged(layout.mem0, { now: Date.now() })).toEqual([]);
      expect(writeDecision(layout.mem0, FACT, true, 0)).toBe("not_found");
    } finally {
      other.dispose();
    }
  });

  it("reads a decision back and lists oldest first, clipping the text", () => {
    setup();
    layout.fact(FACT, { createdAt: "2026-10-16T09:00:00.000Z", text: "x".repeat(5000) });
    layout.fact(FACT2, { createdAt: "2026-10-16T08:00:00.000Z" });
    expect(writeDecision(layout.mem0, FACT, false, 1)).toBe("written");
    const listed = listStaged(layout.mem0, { now: Date.now() });
    expect(listed.map((each) => [each.id, each.decision])).toEqual([
      [FACT2, null],
      [FACT, "rejected"],
    ]);
    expect(listed[1]?.text).toHaveLength(MEM0_LIMITS.textChars);
  });

  it("caps the queue at 200 facts", () => {
    setup();
    for (let i = 0; i < 205; i++)
      layout.fact(`${String(i).padStart(8, "0")}-e89b-42d3-a456-426614174000`, {
        createdAt: `2026-10-16T08:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`,
      });
    expect(listStaged(layout.mem0, { now: Date.now() })).toHaveLength(MEM0_LIMITS.staged);
  });
});

describe("decision", () => {
  it("writes <id>.decision.json (0600) atomically and leaves no temp file", () => {
    setup();
    layout.fact(FACT);
    expect(writeDecision(layout.mem0, FACT, true, 0)).toBe("written");
    const staging = join(layout.mem0, "staging");
    expect(files(staging)).toEqual([`${FACT}.decision.json`, `${FACT}.json`]);
    expect(JSON.parse(readFileSync(join(staging, `${FACT}.decision.json`), "utf8"))).toEqual({
      approved: true,
    });
    expect(mode(join(staging, `${FACT}.decision.json`))).toBe(0o600);
  });

  it("answers not_found for an unknown or malformed fact id, and writes nothing", () => {
    setup();
    layout.fact(FACT);
    expect(writeDecision(layout.mem0, FACT2, true, 0)).toBe("not_found");
    expect(writeDecision(layout.mem0, "../x", true, 0)).toBe("not_found");
    expect(files(join(layout.mem0, "staging"))).toEqual([`${FACT}.json`]);
  });

  it("answers applying while pi-mem0 holds a fresh .processing claim, and writes once it is stale", () => {
    setup();
    layout.fact(FACT);
    const claim = join(layout.mem0, "staging", `${FACT}.processing`);
    writeFileSync(claim, "");
    const at = 1_700_000_000_000;
    utimesSync(claim, at / 1000, at / 1000);
    expect(writeDecision(layout.mem0, FACT, true, at + 10 * 60_000)).toBe("applying");
    expect(files(join(layout.mem0, "staging"))).not.toContain(`${FACT}.decision.json`);
    expect(writeDecision(layout.mem0, FACT, true, at + 10 * 60_000 + 1)).toBe("written");
  });

  it("does not create a staging folder", () => {
    setup();
    mkdirSync(join(layout.mem0, "x"));
    expect(writeDecision(layout.mem0, FACT, true, 0)).toBe("not_found");
    expect(readdirSync(layout.mem0)).toEqual(["x"]);
  });
});

describe("staging reads (fix round 1)", () => {
  it("filters by agent before the cap, so another agent's 201 facts hide nothing", () => {
    setup();
    for (let i = 0; i < 201; i++)
      layout.fact(`${String(i).padStart(8, "0")}-e89b-42d3-a456-426614174000`, {
        agent: "ghost-1a2b",
        createdAt: `2026-10-16T07:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`,
      });
    layout.fact(FACT);
    const listed = listStaged(layout.mem0, { accept: (agent) => agent === AGENT, now: Date.now() });
    expect(listed.map((each) => each.id)).toEqual([FACT]);
    expect(listStaged(layout.mem0, { now: Date.now() })).toHaveLength(MEM0_LIMITS.staged);
  });

  it("marks a claimed fact (.processing) as applying", () => {
    setup();
    layout.fact(FACT);
    layout.fact(FACT2);
    layout.json(`staging/${FACT2}.processing`, "{}");
    expect(listStaged(layout.mem0, { now: Date.now() }).map((each) => [each.id, each.applying])).toEqual([
      [FACT, false],
      [FACT2, true],
    ]);
  });

  it("marks applying only while the claim is under 10 minutes old (the writeDecision rule)", () => {
    setup();
    layout.fact(FACT);
    const claim = join(layout.mem0, "staging", `${FACT}.processing`);
    writeFileSync(claim, "");
    const at = 1_700_000_000_000;
    utimesSync(claim, at / 1000, at / 1000);
    const applying = (now: number) => listStaged(layout.mem0, { now }).map((each) => each.applying);
    expect(applying(at + 10 * 60_000)).toEqual([true]);
    expect(applying(at + 10 * 60_000 + 1)).toEqual([false]);
    expect(readStagedFact(layout.mem0, FACT, at + 10 * 60_000)?.applying).toBe(true);
    expect(readStagedFact(layout.mem0, FACT, at + 10 * 60_000 + 1)?.applying).toBe(false);
  });

  it("counts and skips a malformed fact, an over-16 KB fact and a createdAt over 64 characters", () => {
    setup();
    layout.fact(FACT);
    layout.fact(FACT2, { createdAt: "x".repeat(65) });
    layout.json("staging/323e4567-e89b-42d3-a456-426614174000.json", "{nope");
    layout.fact("423e4567-e89b-42d3-a456-426614174000", { text: "x".repeat(MEM0_LIMITS.factBytes) });
    const skipped = { count: 0 };
    expect(listStaged(layout.mem0, { skipped, now: Date.now() }).map((each) => each.id)).toEqual([FACT]);
    expect(skipped.count).toBe(3);
  });

  it("with a cache: a file is read once while unchanged, a skipped one stays counted, a deleted one leaves the cache", () => {
    setup();
    const cache = createStagedCache();
    const path = layout.fact(FACT);
    layout.json("staging/323e4567-e89b-42d3-a456-426614174000.json", "{nope");
    const list = () => {
      const skipped = { count: 0 };
      const ids = listStaged(layout.mem0, { cache, skipped, now: Date.now() }).map((each) => each.id);
      return { ids, skipped: skipped.count };
    };
    expect(list()).toEqual({ ids: [FACT], skipped: 1 });
    expect(list()).toEqual({ ids: [FACT], skipped: 1 });
    expect(cache.reads).toBe(2);
    expect(cache.entries.size).toBe(2);
    // The decision and the claim are not cached: a decision written later shows at once.
    writeDecision(layout.mem0, FACT, true, Date.now());
    expect(listStaged(layout.mem0, { cache, now: Date.now() })[0]?.decision).toBe("approved");
    expect(cache.reads).toBe(2);
    rmSync(path);
    list();
    expect(cache.entries.size).toBe(1);
  });

  it("with a cache: keeps at most `max` entries and still reads the rest each time", () => {
    setup();
    const cache = createStagedCache(2);
    for (let i = 0; i < 3; i++) layout.fact(`${i}23e4567-e89b-42d3-a456-426614174000`);
    listStaged(layout.mem0, { cache, now: Date.now() });
    expect(cache.entries.size).toBe(2);
    expect(cache.reads).toBe(3);
    listStaged(layout.mem0, { cache, now: Date.now() });
    expect(cache.reads).toBe(4);
  });

  it("reads one fact by id without a window", () => {
    setup();
    layout.fact(FACT);
    expect(readStagedFact(layout.mem0, FACT, Date.now())?.text).toBe("likes tea");
    expect(readStagedFact(layout.mem0, FACT2, Date.now())).toBeNull();
    expect(readStagedFact(layout.mem0, "../x", Date.now())).toBeNull();
  });
});

describe("where pi-mem0's folder is", () => {
  it("takes an absolute PI_MEM0_DIR, else <Pi agent dir>/mem0", () => {
    expect(mem0Dir({ PI_MEM0_DIR: "/srv/mem0" }, "/pi")).toBe("/srv/mem0");
    expect(mem0Dir({}, "/pi")).toBe("/pi/mem0");
  });

  it("falls back for an empty PI_MEM0_DIR and says so", () => {
    const seen: string[] = [];
    expect(mem0Dir({ PI_MEM0_DIR: "" }, "/pi", () => seen.push("warned"))).toBe("/pi/mem0");
    expect(mem0Dir({}, "/pi", () => seen.push("unset"))).toBe("/pi/mem0");
    expect(seen).toEqual(["warned"]);
  });

  it("falls back for a relative PI_MEM0_DIR and says so", () => {
    const seen: string[] = [];
    expect(mem0Dir({ PI_MEM0_DIR: "rel/mem0" }, "/pi", () => seen.push("warned"))).toBe("/pi/mem0");
    mem0Dir({ PI_MEM0_DIR: "/abs" }, "/pi", () => seen.push("again"));
    expect(seen).toEqual(["warned"]);
  });

  it("follows a linked folder, as every operation does", () => {
    setup();
    layout.fact(FACT);
    const link = join(layout.root, "link");
    symlinkSync(layout.mem0, link);
    expect(isInstalled(link)).toBe(true);
    expect(listStaged(link, { now: Date.now() }).map((each) => each.id)).toEqual([FACT]);
    expect(isInstalled(join(layout.root, "absent"))).toBe(false);
  });
});
