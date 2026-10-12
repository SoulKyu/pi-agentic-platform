import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { ALLOW_ASK, createPipelineBed } from "../testing/pipeline-bed.ts";
import { DENIED_REASON, FAIL_CLOSED_REASON, type Stages, TOO_LARGE_REASON } from "./pipeline.ts";

let bed: Awaited<ReturnType<typeof createPipelineBed>>;
let stderr: string[];
beforeAll(async () => {
  bed = await createPipelineBed();
});
afterAll(() => bed.dispose());
beforeEach(() => {
  stderr = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => (stderr.push(String(chunk)), true));
});
afterEach(() => vi.restoreAllMocks());

it.each([
  [
    "a cycle",
    () => {
      const a: Record<string, unknown> = {};
      a.self = a;
      return a;
    },
  ],
  [
    "a getter that throws",
    () =>
      Object.defineProperty({}, "path", {
        enumerable: true,
        get() {
          throw new Error("boom");
        },
      }),
  ],
  ["a function", () => ({ path: "a", run: () => 1 })],
  ["a bigint", () => ({ size: 10n })],
  ["a 33-level nesting", () => Array.from({ length: 33 }).reduce<unknown>((inner) => ({ inner }), {})],
])("fails closed on an input that cannot be stated: %s", async (_name, make) => {
  const h = bed.harness();
  expect(await h.run("mystery_tool", make())).toEqual({ block: true, reason: FAIL_CLOSED_REASON });
  expect(h.entries.at(-1)).toMatchObject({
    decision: "block",
    reason: "evaluation error",
    args: "[unreadable input]",
  });
  expect(stderr).toEqual([expect.stringMatching(/^pi-host: policy evaluation failed \([A-Za-z]{1,64}\)\n$/)]);
});

it("never puts the error message or the input on stderr", async () => {
  const h = bed.harness();
  await h.run("mystery_tool", { size: 10n, token: "hunter2" });
  expect(stderr.join("")).not.toContain("hunter2");
  expect(stderr.join("")).not.toContain("bigint");
});

it("clips tool names and ids to 256 in the entry and escapes hidden characters in the arguments", async () => {
  const h = bed.harness({ answers: [{ answer: "deny", closed: false }] });
  await h.run(`t${"x".repeat(400)}`, { cmd: "a\u202Eb\u0000c" }, "i".repeat(400));
  const entry = h.entries.at(-1);
  expect(entry?.kind === "call" && entry.tool.length).toBe(256);
  expect(entry?.kind === "call" && entry.toolCallId.length).toBe(256);
  // JSON already spells NUL as the six characters \u0000; the bidi override is escaped by pap (R87).
  expect(entry?.kind === "call" && entry.args).toBe('{"cmd":"a\\u{202E}b\\u0000c"}');
});

it("clips audit arguments to 2048 code points without splitting a pair", async () => {
  const h = bed.harness();
  await h.run("read", { path: "😀".repeat(3000) });
  const args = h.entries.at(-1)?.kind === "call" ? (h.entries.at(-1) as { args: string }).args : "";
  expect([...args.replace(/…\(\+\d+\)$/, "")].length).toBe(2048);
  expect(args).toMatch(/…\(\+\d+\)$/);
  expect(/[\uD800-\uDBFF]$/.test(args.replace(/…\(\+\d+\)$/, ""))).toBe(false);
});

it("fails closed when a stage throws, without writing the message to stderr", async () => {
  const h = bed.harness({
    stages: {
      denylist: () => {
        throw new TypeError("secret detail");
      },
    },
  });
  expect(await h.run("read", { path: "a" })).toEqual({ block: true, reason: FAIL_CLOSED_REASON });
  expect(stderr).toEqual(["pi-host: policy evaluation failed (TypeError)\n"]);
});

it("fails closed when the audit sink throws, with one stderr line", async () => {
  const h = bed.harness({
    audit: () => {
      throw new Error("ipc gone");
    },
  });
  expect(await h.run("read", { path: "a" })).toEqual({ block: true, reason: FAIL_CLOSED_REASON });
  expect(stderr).toEqual(["pi-host: policy evaluation failed (Error)\n"]);
});

const UNKNOWN_OUTCOMES: [string, object][] = [
  ["a denylist outcome it does not know", { denylist: () => ({ outcome: "deny" }) }],
  ["an egress outcome it does not know", { egress: () => ({ outcome: "allow" }) }],
  ["a guard outcome it does not know", { guard: () => ({ outcome: "block" }) }],
  ["an approval outcome it does not know", { approval: async () => ({ outcome: "maybe" }) }],
  ["a stage that returns nothing", { denylist: () => undefined }],
];

it.each(UNKNOWN_OUTCOMES)("fails closed on %s", async (_name, stages) => {
  const h = bed.harness({ stages: stages as Partial<Stages> });
  expect(await h.run("read", { path: "a" })).toEqual({ block: true, reason: FAIL_CLOSED_REASON });
  expect(h.entries.at(-1)).toMatchObject({
    decision: "block",
    reason: "evaluation error",
    category: "read",
    args: '{"path":"a"}',
  });
});

it("treats an answer that was not offered as a refusal", async () => {
  const h = bed.harness({ answers: [{ answer: "maybe" as never, closed: false }] });
  expect(await h.run("bash", { command: "ls" })).toEqual({ block: true, reason: DENIED_REASON });
  expect(h.entries.at(-1)).toMatchObject({ decision: "denied", reason: "answer not offered" });
  const unoffered = bed.harness({ answers: [{ answer: "always", closed: false }], stages: ALLOW_ASK });
  expect(await unoffered.run("bash", { command: "ls" })).toEqual({ block: true, reason: DENIED_REASON });
});

it("fails closed on an answered call when the re-check meets an unknown stage outcome", async () => {
  let version = 0;
  const h = bed.harness({
    rulesVersion: () => version,
    ask: async () => (version++, { answer: "once", closed: false }),
    stages: {
      ...ALLOW_ASK,
      denylist: () => (version > 0 ? ({ outcome: "deny" } as never) : { outcome: "pass" }),
    },
  });
  expect(await h.run("bash", { command: "ls" })).toEqual({ block: true, reason: FAIL_CLOSED_REASON });
});

it("blocks an input above the payload bound with its own reason", async () => {
  const h = bed.harness();
  expect(await h.run("bash", { command: "a".repeat(2 * 1024 * 1024 + 1) })).toEqual({
    block: true,
    reason: TOO_LARGE_REASON,
  });
  expect(h.entries.at(-1)).toMatchObject({
    decision: "block",
    reason: "input too large",
    category: "exec",
    args: "[unreadable input]",
  });
  expect(h.asks).toEqual([]);
  // Stage 01 refuses a command this long on its own (denylist.hostile.test.ts): the payload bound is the subject here.
  const edge = bed.harness({ hasUI: false, stages: { denylist: () => ({ outcome: "skip" }) } });
  await edge.run("bash", { command: "a".repeat(2 * 1024 * 1024) });
  expect(edge.entries.at(-1)).toMatchObject({ reason: "no UI to ask" });
});

it("clips an entry reason to 1024 characters", async () => {
  const h = bed.harness({
    stages: { denylist: () => ({ outcome: "block", reason: "r".repeat(3000), modelReason: "no" }) },
  });
  await h.run("read", { path: "a" });
  expect((h.entries.at(-1) as { reason: string }).reason).toBe("r".repeat(1024));
});

it("audits a readable call with its real category and arguments when the evaluation fails", async () => {
  let version = 0;
  const tries = bed.harness({
    rulesVersion: () => version,
    stages: { approval: async () => (version++, { outcome: "allow", reason: "x" }) },
  });
  await tries.run("read", { path: "src/a.ts" });
  expect(tries.entries.at(-1)).toMatchObject({
    reason: "policy changed during evaluation",
    category: "read",
    args: '{"path":"src/a.ts"}',
  });
  const thrown = bed.harness({
    stages: {
      denylist: () => {
        throw new TypeError("x");
      },
    },
  });
  await thrown.run("bash", { command: "ls -la" });
  expect(thrown.entries.at(-1)).toMatchObject({
    reason: "evaluation error",
    category: "exec",
    args: "ls -la",
  });
});
