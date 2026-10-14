import { PapError } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { modelsBed } from "./testing/bed.ts";

const discovered = { models: [{ id: "m1", contextWindow: 8192 }] };
const tested = { ok: true, latencyMs: 41 };
const codeOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof PapError ? error.code : "other"),
  );

describe("models service: discover", () => {
  it("asks for the password step-up before any helper starts, and a token never passes", async () => {
    const { service, calls, clock } = modelsBed(() => discovered);
    expect(await codeOf(service.discover(testCaller(), { provider: "mine" }))).toBe("step_up_required");
    expect(
      await codeOf(service.discover(testCaller({ stepUpUntil: clock.now() }), { provider: "mine" })),
    ).toBe("step_up_required");
    expect(
      await codeOf(
        service.discover(testCaller({ kind: "token", stepUpUntil: clock.now() + 60_000 }), {
          provider: "mine",
        }),
      ),
    ).toBe("step_up_required");
    expect(calls).toHaveLength(0);
  });

  it("runs one helper operation with a deadline and returns the parsed list", async () => {
    const { service, calls, clock } = modelsBed(() => discovered);
    const caller = testCaller({ stepUpUntil: clock.now() + 60_000 });
    expect(await service.discover(caller, { provider: "mine" })).toEqual(discovered);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ op: "models.discover", params: { provider: "mine" } });
    expect(calls[0]?.options.cwd).toBeUndefined();
    expect(calls[0]?.options.deadlineMs).toBe(60_000);
  });

  it("audits the discovery with the provider and nothing else, once the request ran", async () => {
    const { service, audit, clock } = modelsBed(() => discovered);
    await service.discover(testCaller({ stepUpUntil: clock.now() + 60_000 }), { provider: "mine" });
    expect(audit).toEqual([
      {
        ownerId: "u1",
        actor: "user",
        kind: "auth",
        reason: "provider_discovered",
        detail: { provider: "mine" },
      },
    ]);
    const failing = modelsBed(() => new PapError("helper_failed"));
    await codeOf(
      failing.service.discover(testCaller({ stepUpUntil: failing.clock.now() + 60_000 }), {
        provider: "mine",
      }),
    );
    expect(failing.audit).toEqual([]);
  });

  it("passes a status class through and refuses any field the contract does not name", async () => {
    const caller = (clock: { now(): number }) => testCaller({ stepUpUntil: clock.now() + 60_000 });
    const failed = modelsBed(() => ({ models: [], code: "http_4xx" }));
    expect(await failed.service.discover(caller(failed.clock), { provider: "mine" })).toEqual({
      models: [],
      code: "http_4xx",
    });
    const leaky = modelsBed(() => ({ models: [{ id: "m", apiKey: "sk-LEAK" }] }));
    expect(await codeOf(leaky.service.discover(caller(leaky.clock), { provider: "mine" }))).toBe(
      "helper_failed",
    );
    expect(JSON.stringify(leaky.lines)).not.toContain("sk-LEAK");
    const body = modelsBed(() => ({ models: [], code: "bad key sk-LEAK" }));
    expect(await codeOf(body.service.discover(caller(body.clock), { provider: "mine" }))).toBe(
      "helper_failed",
    );
  });

  it("passes the helper's typed failures through", async () => {
    const { service, clock } = modelsBed(() => new PapError("not_found"));
    expect(
      await codeOf(service.discover(testCaller({ stepUpUntil: clock.now() + 60_000 }), { provider: "x" })),
    ).toBe("not_found");
  });
});

describe("models service: test", () => {
  it("runs one helper operation with a deadline, no step-up, and returns the parsed answer", async () => {
    const { service, calls } = modelsBed(() => tested);
    expect(await service.test(testCaller(), { provider: "mine", modelId: "m1" })).toEqual(tested);
    expect(calls[0]).toMatchObject({ op: "models.test", params: { provider: "mine", modelId: "m1" } });
    expect(calls[0]?.options.deadlineMs).toBe(60_000);
  });

  it("refuses a result with a message or a key in it", async () => {
    const { service, lines } = modelsBed(() => ({ ok: false, latencyMs: 3, message: "401 sk-LEAK" }));
    expect(await codeOf(service.test(testCaller(), { provider: "mine", modelId: "m1" }))).toBe(
      "helper_failed",
    );
    expect(JSON.stringify(lines)).not.toContain("sk-LEAK");
  });
});
