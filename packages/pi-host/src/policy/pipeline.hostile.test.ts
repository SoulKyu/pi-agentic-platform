import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createPipelineBed } from "../testing/pipeline-bed.ts";
import { FAIL_CLOSED_REASON } from "./pipeline.ts";

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
