import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// What a browser does with the daemon's CSP (no 'unsafe-eval') when code builds a function from a string.
const realFunction = globalThis.Function;
const attempts: unknown[][] = [];
function blockEval(): void {
  globalThis.Function = new Proxy(realFunction, {
    apply(target, thisArg, args: unknown[]) {
      if (args.length === 0) return Reflect.apply(target, thisArg, args);
      attempts.push(args);
      throw new EvalError("Refused to evaluate a string as JavaScript");
    },
    construct(target, args: unknown[], newTarget) {
      if (args.length === 0) return Reflect.construct(target, args, newTarget);
      attempts.push(args);
      throw new EvalError("Refused to evaluate a string as JavaScript");
    },
  });
}

beforeEach(() => {
  vi.resetModules();
  attempts.length = 0;
  blockEval();
});
afterEach(() => {
  globalThis.Function = realFunction;
});

describe("zod under the daemon's CSP", () => {
  it("tries to compile a function from a string when nothing tells it not to (the control)", async () => {
    await import("@pap/contracts");
    expect(attempts.length).toBeGreaterThan(0);
  });

  it("never does once csp-safe-zod is imported first, and still validates", async () => {
    await import("./csp-safe-zod.ts");
    const { SessionStreamEvent } = await import("@pap/contracts");
    expect(SessionStreamEvent.safeParse({ kind: "status", status: "idle" }).success).toBe(true);
    expect(SessionStreamEvent.safeParse({ kind: "status", status: "bogus" }).success).toBe(false);
    expect(attempts).toEqual([]);
  });

  it("is the first import of the entry, so it runs before any schema is built", () => {
    const entry = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
    expect(entry.split("\n")[0]).toBe('import "./csp-safe-zod.ts";');
  });
});
