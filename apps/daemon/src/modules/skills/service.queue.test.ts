import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { testCaller } from "../../testing/caller.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { fakePool, type RunCall } from "../models/testing/bed.ts";
import { createSkillsService } from "./service.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("skill installs and invocation switches share one queue (MC55, T24 M9)", () => {
  it("does not start a switch while an install of the same folders runs, and starts it when the install ends", async () => {
    const gates = new Map<string, (value: unknown) => void>();
    const { pool, calls } = fakePool((call: RunCall) =>
      call.op === "skills.install"
        ? new Promise<unknown>((resolve) => gates.set(call.op, resolve))
        : { results: [{ path: "/h/.agents/skills/a/SKILL.md", ok: true }] },
    );
    const clock = createFakeClock();
    const service = createSkillsService({
      helpers: pool,
      projects: { covers: () => true },
      logger: captureLogger().logger,
      clock,
    });
    const caller = testCaller({ stepUpUntil: clock.now() + 60_000 });
    const install = service.install(caller, { source: "o/r", scope: "global" });
    await tick();
    const switched = service.setInvocation(caller, {
      items: [{ path: "/h/.agents/skills/a/SKILL.md", disabled: true }],
    });
    await tick();
    expect(calls.map((call) => call.op)).toEqual(["skills.install"]);
    gates.get("skills.install")?.({ ok: true });
    await install;
    await switched;
    expect(calls.map((call) => call.op)).toEqual(["skills.install", "skills.setInvocation"]);
  });
});
