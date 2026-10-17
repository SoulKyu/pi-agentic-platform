import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { UsageError } from "../usage.ts";
import { runDoctor } from "./run.ts";
import type { Check, CheckResult, DoctorContext } from "./types.ts";

const check = (id: string, result: CheckResult | (() => Promise<CheckResult>)): Check => ({
  id,
  title: `title of ${id}`,
  run: typeof result === "function" ? result : async () => result,
});
const ctxWith = (clock = createFakeClock()) => ({ clock }) as unknown as DoctorContext;
const ok: CheckResult = { status: "ok", detail: "fine" };

describe("runDoctor", () => {
  it("keeps the registry order", async () => {
    const report = await runDoctor([check("b", ok), check("a", ok), check("c", ok)], ctxWith());
    expect(report.results.map((r) => r.id)).toEqual(["b", "a", "c"]);
    expect(report.results[0]).toEqual({ id: "b", title: "title of b", ...ok });
  });

  it("--only filters, in registry order; an unknown id is a usage error that lists the known ids", async () => {
    const checks = [check("a", ok), check("b", ok), check("c", ok)];
    const report = await runDoctor(checks, ctxWith(), ["c", "a"]);
    expect(report.results.map((r) => r.id)).toEqual(["a", "c"]);
    const error = await runDoctor(checks, ctxWith(), ["a", "nope"]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toContain("nope");
    expect((error as Error).message).toContain("a, b, c");
  });

  it.each([
    [["ok", "info", "skip"], 0],
    [["ok", "warn"], 2],
    [["warn", "fail", "ok"], 1],
    [["fail"], 1],
    [[], 0],
  ] as const)("exit for %j is %i", async (statuses, exit) => {
    const checks = statuses.map((status, i) => check(`c${i}`, { status, detail: "d", fix: "x" }));
    expect((await runDoctor(checks, ctxWith())).exit).toBe(exit);
  });

  it("a throwing check is a fail with a fixed sentence and does not stop the others", async () => {
    const boom = check("boom", () => Promise.reject(new Error("secret internals /home/x")));
    const sync: Check = {
      id: "sync",
      title: "t",
      run: () => {
        throw new Error("sync secret");
      },
    };
    const report = await runDoctor([boom, sync, check("after", ok)], ctxWith());
    expect(report.results.map((r) => r.status)).toEqual(["fail", "fail", "ok"]);
    expect(report.results[0]).toMatchObject({ detail: "the check could not run", fix: "report this" });
    expect(JSON.stringify(report)).not.toContain("secret");
    expect(report.exit).toBe(1);
  });

  it("a check that never answers is a warn after 10 s of the injected clock", async () => {
    const clock = createFakeClock();
    const hang = check("hang", () => new Promise<CheckResult>(() => undefined));
    const pending = runDoctor([hang, check("after", ok)], ctxWith(clock));
    await clock.advance(9_999);
    let settled = false;
    void pending.then(() => (settled = true));
    await clock.advance(0);
    expect(settled).toBe(false);
    await clock.advance(2);
    const report = await pending;
    expect(report.results[0]).toMatchObject({ id: "hang", status: "warn" });
    expect(report.results[0]?.detail).toContain("timed out");
    expect(report.results[0]?.fix).toBeTruthy();
    expect(report.results[1]?.status).toBe("ok");
    expect(report.exit).toBe(2);
  });

  it("a fast check leaves no timer behind", async () => {
    const clock = createFakeClock();
    await runDoctor([check("a", ok)], ctxWith(clock));
    expect(clock.pending()).toBe(0);
  });
});
