import { PapError } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { modelsBed } from "./testing/bed.ts";

const KEY = "sk-ant-THE-KEY-123";
const confirmed = (now: number) => testCaller({ stepUpUntil: now + 60_000 });
const codeOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof PapError ? error.code : "other"),
  );
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const ok = { ok: true };

describe("the password step-up (owner c3)", () => {
  it("refuses models.login and models.setApiKey without one, before any helper runs", async () => {
    const { service, calls, clock } = modelsBed(() => ok);
    const plain = testCaller();
    expect(await codeOf(service.login(plain, { provider: "anthropic", method: "oauth" }))).toBe(
      "step_up_required",
    );
    expect(await codeOf(service.setApiKey(plain, { provider: "anthropic", key: KEY }))).toBe(
      "step_up_required",
    );
    const expired = testCaller({ stepUpUntil: clock.now() });
    expect(await codeOf(service.login(expired, { provider: "anthropic", method: "oauth" }))).toBe(
      "step_up_required",
    );
    expect(await codeOf(service.setApiKey(expired, { provider: "anthropic", key: KEY }))).toBe(
      "step_up_required",
    );
    expect(calls).toEqual([]);
  });

  it("refuses a token even when it carries a live step-up stamp", async () => {
    const { service, calls, clock } = modelsBed(() => ok);
    const token = testCaller({ kind: "token", stepUpUntil: clock.now() + 60_000 });
    expect(await codeOf(service.login(token, { provider: "anthropic", method: "oauth" }))).toBe(
      "step_up_required",
    );
    expect(await codeOf(service.setApiKey(token, { provider: "anthropic", key: KEY }))).toBe(
      "step_up_required",
    );
    expect(calls).toEqual([]);
  });

  it("is not asked for sign-out, which only removes a credential (M7R133)", async () => {
    const { service, calls } = modelsBed(() => ok);
    expect(await service.logout(testCaller(), { provider: "anthropic" })).toEqual(ok);
    expect(calls[0]).toMatchObject({ op: "auth.logout", params: { provider: "anthropic" } });
  });
});

describe("models.setApiKey", () => {
  it("runs the helper with the key, answers ok with nothing else, and audits the provider only", async () => {
    const { service, calls, audit, clock } = modelsBed(() => ok);
    const result = await service.setApiKey(confirmed(clock.now()), { provider: "anthropic", key: KEY });
    expect(result).toEqual(ok);
    expect(calls[0]).toMatchObject({ op: "auth.setApiKey", params: { provider: "anthropic", key: KEY } });
    expect(calls[0]?.options.deadlineMs).toBeGreaterThan(0);
    expect(audit).toEqual([
      {
        ownerId: "u1",
        actor: "user",
        kind: "auth",
        reason: "provider_key_set",
        detail: { provider: "anthropic" },
      },
    ]);
    expect(JSON.stringify(audit)).not.toContain(KEY);
  });

  it("audits nothing and logs no key when the helper fails", async () => {
    const { service, audit, lines, clock } = modelsBed(() => new PapError("config_hard_link"));
    expect(await codeOf(service.setApiKey(confirmed(clock.now()), { provider: "anthropic", key: KEY }))).toBe(
      "config_hard_link",
    );
    expect(audit).toEqual([]);
    expect(JSON.stringify(lines)).not.toContain(KEY);
  });

  it("refuses a result with an extra field as helper_failed and logs none of it", async () => {
    const { service, audit, lines, clock } = modelsBed(() => ({ ok: true, key: KEY }));
    expect(await codeOf(service.setApiKey(confirmed(clock.now()), { provider: "anthropic", key: KEY }))).toBe(
      "helper_failed",
    );
    expect(audit).toEqual([]);
    expect(JSON.stringify(lines)).not.toContain(KEY);
  });
});

describe("models.logout", () => {
  it("audits the sign-out with the provider and nothing else", async () => {
    const { service, audit } = modelsBed(() => ok);
    await service.logout(testCaller(), { provider: "anthropic" });
    expect(audit).toEqual([
      {
        ownerId: "u1",
        actor: "user",
        kind: "auth",
        reason: "provider_signed_out",
        detail: { provider: "anthropic" },
      },
    ]);
  });

  it("passes the helper's not_found and fixed codes on, and audits nothing", async () => {
    const { service, audit } = modelsBed(() => new PapError("not_found"));
    expect(await codeOf(service.logout(testCaller(), { provider: "nobody" }))).toBe("not_found");
    expect(audit).toEqual([]);
  });
});

describe("models.cancelLogin", () => {
  it("needs no step-up, cancels the caller's flow for the provider, and refuses another user's", async () => {
    const { service, clock, published } = modelsBed(() => new Promise(() => {}) as never);
    const { flowId } = await service.login(confirmed(clock.now()), {
      provider: "anthropic",
      method: "oauth",
    });
    expect(await codeOf(service.cancelLogin(testCaller({ userId: "u2" }), { provider: "anthropic" }))).toBe(
      "not_found",
    );
    expect(await service.cancelLogin(testCaller(), { provider: "anthropic" })).toEqual(ok);
    expect(published.at(-1)).toEqual({ stream: "login", key: flowId, event: { kind: "done", ok: false } });
    expect(await codeOf(service.cancelLogin(testCaller(), { provider: "anthropic" }))).toBe("not_found");
    await service.login(confirmed(clock.now()), { provider: "anthropic", method: "oauth" });
  });
});

describe("models.login", () => {
  it("starts a flow after a step-up, runs auth.login, and audits the sign-in when it succeeds", async () => {
    const { service, calls, audit, clock } = modelsBed(() => ok);
    const { flowId } = await service.login(confirmed(clock.now()), {
      provider: "anthropic",
      method: "oauth",
    });
    expect(flowId).toMatch(/^\S+$/);
    expect(calls[0]).toMatchObject({ op: "auth.login", params: { provider: "anthropic", method: "oauth" } });
    await settle();
    expect(audit).toEqual([
      {
        ownerId: "u1",
        actor: "user",
        kind: "auth",
        reason: "provider_signed_in",
        detail: { provider: "anthropic", method: "oauth" },
      },
    ]);
  });

  it("audits nothing when the sign-in fails", async () => {
    const { service, audit, clock, published } = modelsBed(() => new PapError("helper_failed"));
    const { flowId } = await service.login(confirmed(clock.now()), {
      provider: "anthropic",
      method: "api_key",
    });
    await settle();
    expect(audit).toEqual([]);
    expect(published).toContainEqual({
      stream: "login",
      key: flowId,
      event: { kind: "done", ok: false, code: "helper_failed" },
    });
  });

  it("keeps a flow to its owner for answer, cancel and subscribe", async () => {
    const { service, clock } = modelsBed(() => ok);
    const { flowId } = await service.login(confirmed(clock.now()), {
      provider: "anthropic",
      method: "oauth",
    });
    const other = testCaller({ userId: "u2" });
    expect(await codeOf(service.loginAnswer(other, { flowId, promptId: "p1", value: "x" }))).toBe(
      "not_found",
    );
    expect(await codeOf(service.loginCancel(other, { flowId }))).toBe("not_found");
    let opened = 0;
    const open = () => `s${++opened}`;
    expect(await codeOf(service.subscribeLogin(other, flowId, open))).toBe("not_found");
    expect(opened).toBe(0);
    expect(await service.subscribeLogin(testCaller(), flowId, open)).toEqual({ sub: "s1" });
  });

  it("does not mark a subscriber when opening the subscription fails", async () => {
    const { service, clock, published } = modelsBed(() => new Promise(() => {}) as never);
    const { flowId } = await service.login(confirmed(clock.now()), {
      provider: "anthropic",
      method: "oauth",
    });
    await expect(
      service.subscribeLogin(testCaller(), flowId, () => {
        throw new PapError("capacity");
      }),
    ).rejects.toMatchObject({ code: "capacity" });
    await clock.advance(60_000);
    expect(published.at(-1)?.event).toEqual({ kind: "done", ok: false, code: "timeout" });
  });
});
