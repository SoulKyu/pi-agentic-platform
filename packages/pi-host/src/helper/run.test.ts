import { HELPER_MAX_RECORD_BYTES, type DaemonToHelper, HelperToDaemon } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineOp, HelperOpError, type OpTable } from "./ops.ts";
import { executeOp, homeOf, serveHelper, type HelperChannel } from "./run.ts";

const run = { type: "helper_run", op: "x", agentDir: "/a", papHome: "/p", params: { n: 1 } } as const;
const deps = { home: "/h" };

const table = (extra: OpTable = {}): OpTable => ({
  echo: defineOp({
    params: z.object({ n: z.number() }).strict(),
    run: async (params) => ({ got: params.n }),
  }),
  boom: defineOp({
    params: z.unknown(),
    run: async () => {
      throw new Error(`boom\n    at secretFunction (/home/x/file.ts:1:1)${"!".repeat(1000)}`);
    },
  }),
  missing: defineOp({
    params: z.unknown(),
    run: async () => {
      throw new HelperOpError("not_found", "no such provider");
    },
  }),
  big: defineOp({ params: z.unknown(), run: async () => "x".repeat(HELPER_MAX_RECORD_BYTES) }),
  ...extra,
});

describe("executeOp", () => {
  it("answers an unknown op with unknown_op, whatever the name (prototype keys included)", async () => {
    for (const op of ["nope", "constructor", "__proto__", "toString"])
      expect(await executeOp({ ...run, op }, table(), deps, new AbortController().signal, noIo)).toEqual({
        type: "helper_done",
        ok: false,
        code: "unknown_op",
      });
  });

  it("answers invalid params with bad_params and never runs the op", async () => {
    let ran = false;
    const ops = table({
      guarded: defineOp({
        params: z.object({ n: z.number() }).strict(),
        run: async () => {
          ran = true;
          return null;
        },
      }),
    });
    const done = await executeOp({ ...run, op: "guarded", params: { n: "1" } }, ops, deps, signal(), noIo);
    expect(done).toEqual({ type: "helper_done", ok: false, code: "bad_params" });
    expect(ran).toBe(false);
  });

  it("returns the result of an op that works", async () => {
    expect(await executeOp({ ...run, op: "echo" }, table(), deps, signal(), noIo)).toEqual({
      type: "helper_done",
      ok: true,
      result: { got: 1 },
    });
  });

  it("answers a throwing op with failed and a clipped detail that holds no stack", async () => {
    const done = await executeOp({ ...run, op: "boom" }, table(), deps, signal(), noIo);
    expect(done).toMatchObject({ ok: false, code: "failed", detail: "Error: boom" });
    expect(JSON.stringify(done)).not.toContain("secretFunction");
    expect(HelperToDaemon.safeParse(done).success).toBe(true);
  });

  it("keeps the code and the clipped detail of a HelperOpError", async () => {
    expect(await executeOp({ ...run, op: "missing" }, table(), deps, signal(), noIo)).toEqual({
      type: "helper_done",
      ok: false,
      code: "not_found",
      detail: "no such provider",
    });
  });
});

const signal = () => new AbortController().signal;
const noIo = { emit: () => {}, prompt: async () => null };

function fakeChannel() {
  const sent: HelperToDaemon[] = [];
  let listener: (raw: unknown) => void = () => {};
  const channel: HelperChannel = {
    send: async (record) => void sent.push(record),
    onMessage: (next) => void (listener = next),
  };
  return { channel, sent, deliver: (record: DaemonToHelper | unknown) => listener(record) };
}

describe("serveHelper", () => {
  it("runs the first record and sends one helper_done", async () => {
    const bed = fakeChannel();
    const served = serveHelper(bed.channel, table());
    bed.deliver({ ...run, op: "echo" });
    await served;
    expect(bed.sent).toEqual([{ type: "helper_done", ok: true, result: { got: 1 } }]);
  });

  it("refuses a first record that is not a valid run record with bad_params", async () => {
    const bed = fakeChannel();
    const served = serveHelper(bed.channel, table());
    bed.deliver({ type: "helper_cancel" });
    await served;
    expect(bed.sent).toEqual([{ type: "helper_done", ok: false, code: "bad_params" }]);
  });

  it("replaces a result over the record bound with a failed answer", async () => {
    const bed = fakeChannel();
    const served = serveHelper(bed.channel, table());
    bed.deliver({ ...run, op: "big" });
    await served;
    expect(bed.sent).toEqual([
      { type: "helper_done", ok: false, code: "failed", detail: "result too large" },
    ]);
  });

  it("round-trips a prompt answer and resolves a pending prompt with null on cancel", async () => {
    const bed = fakeChannel();
    const ops = table({
      ask: defineOp({
        params: z.unknown(),
        run: async (_params, ctx) => {
          const first = await ctx.prompt({ q: 1 });
          const second = await ctx.prompt({ q: 2 });
          return { first, second, aborted: ctx.signal.aborted };
        },
      }),
    });
    const served = serveHelper(bed.channel, ops);
    bed.deliver({ ...run, op: "ask" });
    await Promise.resolve();
    await Promise.resolve();
    expect(bed.sent[0]).toEqual({ type: "helper_prompt", promptId: "p1", prompt: { q: 1 } });
    bed.deliver({ type: "helper_answer", promptId: "p1", value: "yes" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(bed.sent[1]).toEqual({ type: "helper_prompt", promptId: "p2", prompt: { q: 2 } });
    bed.deliver({ type: "helper_answer", promptId: "nope", value: "ignored" });
    bed.deliver({ type: "helper_cancel" });
    await served;
    expect(bed.sent[2]).toEqual({
      type: "helper_done",
      ok: true,
      result: { first: "yes", second: null, aborted: true },
    });
  });

  it("throws a failed answer when an op emits a record over the bound", async () => {
    const bed = fakeChannel();
    const ops = table({
      noisy: defineOp({
        params: z.unknown(),
        run: async (_params, ctx) => {
          ctx.emit("x".repeat(HELPER_MAX_RECORD_BYTES));
          return null;
        },
      }),
    });
    const served = serveHelper(bed.channel, ops);
    bed.deliver({ ...run, op: "noisy" });
    await served;
    expect(bed.sent).toEqual([
      { type: "helper_done", ok: false, code: "failed", detail: "Error: record too large" },
    ]);
  });
});

describe("homeOf (M7R104)", () => {
  it("takes HOME, and falls back to the account's own folder, never to /", () => {
    expect(homeOf({ HOME: "/home/me" }, () => "/acct")).toBe("/home/me");
    expect(homeOf({}, () => "/acct")).toBe("/acct");
    expect(homeOf({ HOME: "" }, () => "/acct")).toBe("/acct");
    expect(homeOf({ HOME: "relative" }, () => "/acct")).toBe("/acct");
  });
});
