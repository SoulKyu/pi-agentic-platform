import { afterEach, describe, expect, it, vi } from "vitest";
import { createCrashBed, type CrashBed, type Life } from "./daemon-process.ts";

// FLAKE-W5-2: `listening` is logged by the daemon's start and `setup_url` right after, by main.ts. The harness returns
// from `start()` on `listening`, so under load `signUp` ran before the second line had reached the pipe.

let bed: CrashBed | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await bed?.dispose();
  bed = undefined;
});

const lifeWithLines = (lines: Array<Record<string, unknown>>): Life =>
  ({ lines, stderr: () => "", port: 9, origin: "http://localhost:9" }) as unknown as Life;

describe("signUp and a setup_url line that arrives after `listening`", () => {
  it("waits for the line instead of failing at once", async () => {
    vi.useFakeTimers();
    bed = createCrashBed({ steps: [] });
    const lines: Array<Record<string, unknown>> = [{ msg: "listening" }];
    setTimeout(() => lines.push({ msg: "setup_url", url: "http://localhost:9/#token=abc" }), 120);
    const attempt = bed.signUp(lifeWithLines(lines)).then(
      () => "signed up",
      (failure: unknown) => (failure as Error).message,
    );
    await vi.advanceTimersByTimeAsync(200);
    // The line was found; the sign-up then fails on the closed port, which is not a missing setup line.
    expect(await attempt).toBe("connect ECONNREFUSED 127.0.0.1:9");
  });
});
