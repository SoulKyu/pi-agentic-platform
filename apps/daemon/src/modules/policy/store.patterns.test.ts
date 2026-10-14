import { createHash } from "node:crypto";
import { MAX_ALWAYS_RULES, PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { createPolicyService } from "./service.ts";
import { createPolicyStore } from "./store.ts";
import { createPolicyBed, KEY, keyOf } from "./testing/bed.ts";

let bed: ReturnType<typeof makeBed>;
const makeBed = () => {
  const base = createPolicyBed();
  const store = createPolicyStore(base.db);
  const service = createPolicyService({
    store,
    clock: base.clock,
    logger: base.logger,
    newId: base.newId,
    audit: base.audit,
  });
  return { ...base, store, service };
};
beforeEach(() => {
  bed = makeBed();
});
afterEach(() => bed.dispose());

// The key helper repeats the plan's encoding on purpose: a test must not import the code that computes what it checks.
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const base = { ownerId: "u1", scope: "/w", label: "bash: pnpm test --watch" };
const prefix = { ...base, tool: "bash", kind: "prefix" as const, prefix: ["pnpm", "test"] };
const toolRule = { ...base, tool: "mcp__fix__write", kind: "tool" as const, source: "mcp" as const };
const raw = (id: string) =>
  bed.db.get<{ kind: string; pattern: string | null; grant_key: string }>(
    "SELECT kind, pattern, grant_key FROM approval_rules WHERE id = $id",
    { id },
  );

describe("prefix and tool rules in the store", () => {
  it("keeps one row when the same prefix is added twice, and stores its pattern and key as the plan says", () => {
    const { service } = bed;
    expect(service.addAlways(prefix)).toBe("added");
    expect(service.addAlways({ ...prefix, label: "other label" })).toBe("exists");
    expect(bed.store.count("u1", "/w")).toBe(1);
    expect(raw("r1")).toEqual({
      kind: "prefix",
      pattern: '["pnpm","test"]',
      grant_key: sha(["bash", "prefix", ["pnpm", "test"]]),
    });
  });

  it("stores a tool rule with its source, one row per tool and source", () => {
    const { service } = bed;
    expect(service.addAlways(toolRule)).toBe("added");
    expect(service.addAlways(toolRule)).toBe("exists");
    expect(service.addAlways({ ...toolRule, source: "builtin" as const })).toBe("added");
    expect(raw("r1")).toEqual({
      kind: "tool",
      pattern: '{"source":"mcp"}',
      grant_key: sha(["mcp__fix__write", "tool", { source: "mcp" }]),
    });
  });

  it("keeps an exact rule, a prefix and a tool rule of the same tool apart", () => {
    const { service } = bed;
    expect(service.addAlways({ ...base, tool: "bash", key: KEY })).toBe("added");
    expect(service.addAlways({ ...base, tool: "bash", key: KEY, kind: "exact" })).toBe("exists");
    expect(service.addAlways(prefix)).toBe("added");
    expect(service.addAlways({ ...prefix, prefix: ["pnpm", "build"] })).toBe("added");
    expect(service.addAlways({ ...prefix, prefix: ["pnpm"] })).toBe("added");
    expect(bed.store.count("u1", "/w")).toBe(4);
  });

  it("hands each kind to its own reader: rulesFor stays exact only", () => {
    const { service } = bed;
    service.addAlways({ ...base, tool: "bash", key: KEY });
    service.addAlways(prefix);
    service.addAlways(toolRule);
    expect(service.rulesFor("u1", "/w")).toEqual([{ tool: "bash", key: KEY }]);
    expect(service.prefixesFor("u1", "/w")).toEqual([{ prefix: ["pnpm", "test"] }]);
    expect(service.toolsFor("u1", "/w")).toEqual([{ tool: "mcp__fix__write", source: "mcp" }]);
    for (const owner of ["u2"]) {
      expect(service.prefixesFor(owner, "/w")).toEqual([]);
      expect(service.toolsFor(owner, "/w")).toEqual([]);
    }
    expect(service.prefixesFor("u1", "/other")).toEqual([]);
    expect(service.toolsFor("u1", "/other")).toEqual([]);
  });

  it("lists every kind with its kind and pattern", () => {
    const { service } = bed;
    service.addAlways({ ...base, tool: "bash", key: KEY });
    service.addAlways(prefix);
    service.addAlways(toolRule);
    const views = service.listPage("u1").rules;
    expect(views.map(({ kind, tool, pattern }) => ({ kind, tool, pattern }))).toEqual([
      { kind: "tool", tool: "mcp__fix__write", pattern: undefined },
      { kind: "prefix", tool: "bash", pattern: ["pnpm", "test"] },
      { kind: "exact", tool: "bash", pattern: undefined },
    ]);
  });

  it("skips a stored pattern that is not a rule, with one warning per read, and still lists it for revoking", () => {
    const { service, db } = bed;
    service.addAlways(prefix);
    service.addAlways({ ...toolRule });
    const put = (id: string, kind: string, tool: string, pattern: string, n: number) =>
      db.run(
        "INSERT INTO approval_rules (id, owner_id, scope_kind, scope, tool, grant_key, label, created_at, kind, pattern) VALUES ($id, 'u1', 'project', '/w', $tool, $key, 'x', 9, $kind, $pattern)",
        { id, tool, key: keyOf(n), kind, pattern },
      );
    put("bad1", "prefix", "bash", '"pnpm test"', 1);
    put("bad2", "prefix", "bash", '["pnpm","$(id)"]', 2);
    put("bad3", "prefix", "bash", "[]", 3);
    put("bad4", "prefix", "other", '["pnpm","test"]', 4);
    put("bad5", "tool", "bash", '{"source":"mcp"}', 5);
    put("bad6", "tool", "x", '{"source":"file"}', 6);
    put("bad7", "tool", "x", '{"source":"mcp","extra":1}', 7);
    put("bad8", "tool", "x", "null", 8);
    expect(service.prefixesFor("u1", "/w")).toEqual([{ prefix: ["pnpm", "test"] }]);
    expect(bed.lines.filter((line) => line.msg === "policy_rule_unreadable")).toEqual([
      expect.objectContaining({ kind: "prefix", skipped: 4 }),
    ]);
    expect(service.toolsFor("u1", "/w")).toEqual([{ tool: "mcp__fix__write", source: "mcp" }]);
    expect(bed.lines.filter((line) => line.msg === "policy_rule_unreadable")).toHaveLength(2);
    expect(service.listPage("u1").rules.map((rule) => rule.id)).toContain("bad1");
  });

  it("counts every kind toward the cap of 1000: the 1000th rule may be a prefix, the next of any kind is refused", () => {
    const { service } = bed;
    for (let i = 1; i < MAX_ALWAYS_RULES; i++) service.addAlways({ ...base, tool: "bash", key: keyOf(i) });
    expect(service.addAlways(prefix)).toBe("added");
    expect(service.addAlways(toolRule)).toBe("full");
    expect(service.addAlways({ ...prefix, prefix: ["pnpm", "build"] })).toBe("full");
    expect(service.addAlways({ ...base, tool: "bash", key: keyOf(1000) })).toBe("full");
    expect(service.addAlways(prefix)).toBe("exists");
    expect(bed.lines.filter((line) => line.msg === "approval_rules_full")).toHaveLength(3);
    expect(service.toolsFor("u1", "/w")).toEqual([]);
  });

  it("revokes a prefix rule: it disappears from the reader and the listeners hear it", () => {
    const { service } = bed;
    const heard: string[] = [];
    service.onChange((owner, scope) => void heard.push(`${owner}:${scope}`));
    service.addAlways(prefix);
    service.revoke(testCaller({ userId: "u1" }), "r1");
    expect(service.prefixesFor("u1", "/w")).toEqual([]);
    expect(heard).toEqual(["u1:/w", "u1:/w"]);
    expect(() => service.revoke(testCaller({ userId: "u2" }), "r1")).toThrow(new PapError("not_found"));
  });
});

describe("addAlways input for the new kinds", () => {
  const bad = new PapError("bad_request");
  it.each([
    ["a prefix rule for a tool other than bash", { ...prefix, tool: "write" }],
    ["an empty prefix", { ...prefix, prefix: [] }],
    ["a prefix of five words", { ...prefix, prefix: ["a", "b", "c", "d", "e"] }],
    ["a prefix word with a space", { ...prefix, prefix: ["pnpm", "te st"] }],
    ["a prefix word with a quote", { ...prefix, prefix: ["pnpm", "'x'"] }],
    ["a prefix word with $", { ...prefix, prefix: ["pnpm", "$HOME"] }],
    ["a prefix word with a glob", { ...prefix, prefix: ["pnpm", "t*"] }],
    ["a prefix word over 128 characters", { ...prefix, prefix: ["pnpm", "t".repeat(129)] }],
    ["a tool rule for bash", { ...toolRule, tool: "bash" }],
    ["a tool rule with a source outside builtin and mcp", { ...toolRule, source: "file" }],
    ["a tool rule with a NUL in the tool", { ...toolRule, tool: "mcp\u0000x" }],
    ["a kind outside the three", { ...base, tool: "bash", kind: "glob", key: KEY }],
  ])("throws bad_request and stores nothing for %s", (_name, input) => {
    expect(() => bed.service.addAlways(input as never)).toThrow(bad);
    expect(bed.service.list("u1")).toEqual([]);
  });
});
