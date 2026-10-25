import { PapError } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createLoginFlows, LOGIN_LIMITS } from "./login-flows.ts";
import { bed, type Fake, settle } from "./testing/flows-bed.ts";

const progress = { kind: "progress", message: "Waiting" };
const manual = { type: "manual_code", message: "Paste the code" };

describe("starting a flow", () => {
  it("runs auth.login in the pool with the 10-minute deadline and returns a flow id", () => {
    const { flows, fakes } = bed(createLoginFlows);
    const flowId = flows.start("u1", "anthropic", "oauth");
    expect(flowId).toBe("flow1");
    expect(fakes[0]).toMatchObject({ op: "auth.login", params: { provider: "anthropic", method: "oauth" } });
    expect(fakes[0]?.options.deadlineMs).toBe(LOGIN_LIMITS.deadlineMs);
    expect(LOGIN_LIMITS.deadlineMs).toBe(600_000);
  });

  it("refuses a third flow for the owner with capacity, and never evicts one", () => {
    const { flows, fakes, doneOf } = bed(createLoginFlows);
    flows.start("u1", "a", "oauth");
    flows.start("u1", "b", "oauth");
    expect(() => flows.start("u1", "c", "oauth")).toThrow(expect.objectContaining({ code: "capacity" }));
    expect(fakes).toHaveLength(2);
    expect(fakes.map((fake) => fake.cancelled)).toEqual([0, 0]);
    expect(doneOf("flow1")).toEqual([]);
    expect(doneOf("flow2")).toEqual([]);
  });

  it("refuses a second flow for the same provider with conflict, whoever asks", () => {
    const { flows, fakes } = bed(createLoginFlows);
    flows.start("u1", "a", "oauth");
    expect(() => flows.start("u1", "a", "api_key")).toThrow(expect.objectContaining({ code: "conflict" }));
    expect(() => flows.start("u2", "a", "oauth")).toThrow(expect.objectContaining({ code: "conflict" }));
    expect(fakes).toHaveLength(1);
  });

  it("lets the pool's own refusal through and registers nothing", () => {
    const { flows, setPoolFull } = bed(createLoginFlows);
    setPoolFull(true);
    expect(() => flows.start("u1", "a", "oauth")).toThrow(expect.objectContaining({ code: "pi_busy" }));
    setPoolFull(false);
    expect(flows.start("u1", "a", "oauth")).toMatch(/^flow/);
  });

  it("counts only live flows: an ended one frees its slot and its provider", async () => {
    const { flows, fakes } = bed(createLoginFlows);
    flows.start("u1", "a", "oauth");
    flows.start("u1", "b", "oauth");
    fakes[0]?.finish();
    await settle();
    expect(flows.start("u1", "a", "oauth")).toBe("flow3");
  });
});

describe("events and prompts", () => {
  it("publishes helper events in order under the flow id", () => {
    const { flows, fakes, events, emit } = bed(createLoginFlows);
    const flowId = flows.start("u1", "a", "oauth");
    const url = { kind: "auth_url", url: "https://a.test/x" };
    emit(fakes[0] as Fake, url);
    emit(fakes[0] as Fake, progress);
    expect(events).toEqual([
      { flowId, event: url },
      { flowId, event: progress },
    ]);
  });

  it("publishes a prompt and hands the answer to the helper once", () => {
    const { flows, fakes, events, ask } = bed(createLoginFlows);
    const flowId = flows.start("u1", "a", "oauth");
    ask(fakes[0] as Fake, "p1", manual);
    expect(events).toEqual([{ flowId, event: { kind: "prompt", promptId: "p1", prompt: manual } }]);
    flows.answer("u1", flowId, "p1", "CODE");
    expect(fakes[0]?.answers).toEqual([["p1", "CODE"]]);
    expect(() => flows.answer("u1", flowId, "p1", "CODE")).toThrow(
      expect.objectContaining({ code: "not_found" }),
    );
  });

  it("answers not_found for a prompt that was never asked", () => {
    const { flows } = bed(createLoginFlows);
    const flowId = flows.start("u1", "a", "oauth");
    expect(() => flows.answer("u1", flowId, "p9", "x")).toThrow(
      expect.objectContaining({ code: "not_found" }),
    );
  });

  it("drops a malformed event and a spoofed prompt or done, publishing nothing for them", () => {
    const { flows, fakes, events, emit } = bed(createLoginFlows);
    flows.start("u1", "a", "oauth");
    emit(fakes[0] as Fake, { kind: "auth_url", url: "javascript:alert(1)" });
    emit(fakes[0] as Fake, { kind: "auth_url", url: "http://evil.test/x" });
    emit(fakes[0] as Fake, { kind: "done", ok: true });
    emit(fakes[0] as Fake, { kind: "prompt", promptId: "p1", prompt: manual });
    emit(fakes[0] as Fake, "not even an object");
    emit(fakes[0] as Fake, progress);
    expect(events.map((e) => e.event)).toEqual([progress]);
  });

  it("declines a malformed prompt towards the helper and counts it as dropped", () => {
    const { flows, fakes, events, ask } = bed(createLoginFlows);
    flows.start("u1", "a", "oauth");
    ask(fakes[0] as Fake, "p1", { type: "select", message: "Pick", options: [] });
    expect(events).toEqual([]);
    expect(fakes[0]?.answers).toEqual([["p1", null]]);
  });

  it("ends the flow helper_failed on the eighth dropped event, and cancels the helper", () => {
    const { flows, fakes, emit, doneOf } = bed(createLoginFlows);
    const flowId = flows.start("u1", "a", "oauth");
    for (let i = 0; i < LOGIN_LIMITS.maxDropped - 1; i++) emit(fakes[0] as Fake, { kind: "nope" });
    expect(doneOf(flowId)).toEqual([]);
    expect(fakes[0]?.cancelled).toBe(0);
    emit(fakes[0] as Fake, { kind: "nope" });
    expect(doneOf(flowId)).toEqual([{ flowId, event: { kind: "done", ok: false, code: "helper_failed" } }]);
    expect(fakes[0]?.cancelled).toBe(1);
    expect(LOGIN_LIMITS.maxDropped).toBe(8);
  });

  it("logs a dropped event without any of its content", () => {
    const { flows, fakes, emit, lines } = bed(createLoginFlows);
    flows.start("u1", "a", "oauth");
    emit(fakes[0] as Fake, { kind: "progress", message: "x", extra: "SECRET-TEXT-IN-EVENT" });
    expect(lines.some((line) => line.msg === "login_event_dropped")).toBe(true);
    expect(JSON.stringify(lines)).not.toContain("SECRET-TEXT-IN-EVENT");
  });

  it("ignores what a helper says after the flow ended", () => {
    const { flows, fakes, emit, events, ask } = bed(createLoginFlows);
    const flowId = flows.start("u1", "a", "oauth");
    flows.cancel("u1", flowId);
    const before = events.length;
    emit(fakes[0] as Fake, progress);
    ask(fakes[0] as Fake, "p1", manual);
    expect(events).toHaveLength(before);
  });
});

describe("how a flow ends", () => {
  it("publishes done ok and reports the sign-in once", async () => {
    const { flows, fakes, doneOf, signedIn } = bed(createLoginFlows);
    const flowId = flows.start("u1", "anthropic", "oauth");
    fakes[0]?.finish();
    await settle();
    expect(doneOf(flowId)).toEqual([{ flowId, event: { kind: "done", ok: true } }]);
    expect(signedIn).toEqual([{ ownerId: "u1", provider: "anthropic", method: "oauth" }]);
  });

  it("treats a result that is not { ok: true } as a failure", async () => {
    const { flows, fakes, doneOf, signedIn } = bed(createLoginFlows);
    const flowId = flows.start("u1", "a", "oauth");
    fakes[0]?.finish({ ok: true, key: "sk-LEAK" });
    await settle();
    expect(doneOf(flowId)[0]?.event).toEqual({ kind: "done", ok: false, code: "helper_failed" });
    expect(signedIn).toEqual([]);
  });

  it("publishes the code of a failed run and reports no sign-in", async () => {
    const { flows, fakes, doneOf, signedIn } = bed(createLoginFlows);
    const flowId = flows.start("u1", "a", "oauth");
    fakes[0]?.fail(new PapError("timeout"));
    await settle();
    expect(doneOf(flowId)[0]?.event).toEqual({ kind: "done", ok: false, code: "timeout" });
    expect(signedIn).toEqual([]);
  });

  it("maps anything else that rejects to helper_failed, with no text", async () => {
    const { flows, fakes, doneOf } = bed(createLoginFlows);
    const flowId = flows.start("u1", "a", "oauth");
    fakes[0]?.fail(new Error("sk-SECRET in a message"));
    await settle();
    expect(doneOf(flowId)[0]?.event).toEqual({ kind: "done", ok: false, code: "helper_failed" });
  });

  it("cancels on the owner's word: done without a code, the helper told to stop, one done only", async () => {
    const { flows, fakes, doneOf } = bed(createLoginFlows);
    const flowId = flows.start("u1", "a", "oauth");
    flows.cancel("u1", flowId);
    expect(doneOf(flowId)).toEqual([{ flowId, event: { kind: "done", ok: false } }]);
    expect(fakes[0]?.cancelled).toBe(1);
    fakes[0]?.fail(new PapError("helper_failed"));
    await settle();
    expect(doneOf(flowId)).toHaveLength(1);
    flows.cancel("u1", flowId);
    expect(fakes[0]?.cancelled).toBe(1);
  });

  it("audits a sign-in the helper completed after a cancel raced it, with the stream's single done", async () => {
    const { flows, fakes, signedIn, doneOf } = bed(createLoginFlows);
    const flowId = flows.start("u1", "a", "oauth");
    flows.cancel("u1", flowId);
    fakes[0]?.finish();
    await settle();
    expect(signedIn).toEqual([{ ownerId: "u1", provider: "a", method: "oauth" }]);
    expect(doneOf(flowId)).toEqual([{ flowId, event: { kind: "done", ok: false } }]);
  });

  it("ends the flow and logs, with no text, when reporting the sign-in throws", async () => {
    const { flows, fakes, doneOf, lines } = bed<
      Parameters<typeof createLoginFlows>[0],
      ReturnType<typeof createLoginFlows>
    >((deps) =>
      createLoginFlows({
        ...deps,
        onSignedIn: () => {
          throw new Error("sk-SECRET in an audit failure");
        },
      }),
    );
    const flowId = flows.start("u1", "a", "oauth");
    fakes[0]?.finish();
    await settle();
    expect(doneOf(flowId)).toEqual([{ flowId, event: { kind: "done", ok: true } }]);
    expect(() => flows.start("u1", "a", "oauth")).not.toThrow();
    expect(lines.filter((line) => line.msg === "login_sign_in_report_failed")).toHaveLength(1);
    expect(JSON.stringify(lines)).not.toContain("sk-SECRET");
  });

  it("audits a sign-in that completed after an idle abort, once", async () => {
    const { flows, fakes, signedIn, clock } = bed(createLoginFlows);
    flows.start("u1", "a", "oauth");
    await clock.advance(LOGIN_LIMITS.idleMs);
    fakes[0]?.finish();
    await settle();
    expect(signedIn).toHaveLength(1);
  });

  it("audits nothing for a cancelled flow whose helper failed", async () => {
    const { flows, fakes, signedIn } = bed(createLoginFlows);
    const flowId = flows.start("u1", "a", "oauth");
    flows.cancel("u1", flowId);
    fakes[0]?.fail(new PapError("helper_failed"));
    await settle();
    expect(signedIn).toEqual([]);
  });
});

describe("the flow belongs to its owner (M7R59)", () => {
  it("answers not_found to another user for answer, cancel and attach, and changes nothing", () => {
    const { flows, fakes, ask, doneOf } = bed(createLoginFlows);
    const flowId = flows.start("u1", "a", "oauth");
    ask(fakes[0] as Fake, "p1", manual);
    const notFound = expect.objectContaining({ code: "not_found" });
    expect(() => flows.answer("u2", flowId, "p1", "x")).toThrow(notFound);
    expect(() => flows.cancel("u2", flowId)).toThrow(notFound);
    expect(() => flows.attach("u2", flowId)).toThrow(notFound);
    expect(() => flows.attach("u1", "no-such-flow")).toThrow(notFound);
    expect(fakes[0]?.answers).toEqual([]);
    expect(fakes[0]?.cancelled).toBe(0);
    expect(doneOf(flowId)).toEqual([]);
  });
});

describe("a flow nobody watches (M7R59)", () => {
  it("is cancelled after 60 seconds without a subscriber", async () => {
    const { flows, fakes, clock, doneOf } = bed(createLoginFlows);
    const flowId = flows.start("u1", "a", "oauth");
    await clock.advance(LOGIN_LIMITS.idleMs - 1);
    expect(fakes[0]?.cancelled).toBe(0);
    await clock.advance(1);
    expect(fakes[0]?.cancelled).toBe(1);
    expect(doneOf(flowId)).toEqual([{ flowId, event: { kind: "done", ok: false, code: "timeout" } }]);
    expect(LOGIN_LIMITS.idleMs).toBe(60_000);
  });

  it("is left alone once a subscriber attached, and holds no timer after it ends", async () => {
    const { flows, fakes, clock, doneOf } = bed(createLoginFlows);
    const flowId = flows.start("u1", "a", "oauth");
    flows.attach("u1", flowId);
    expect(clock.pending()).toBe(0);
    await clock.advance(LOGIN_LIMITS.idleMs * 5);
    expect(fakes[0]?.cancelled).toBe(0);
    expect(doneOf(flowId)).toEqual([]);
    fakes[0]?.finish();
    await settle();
    expect(clock.pending()).toBe(0);
  });

  it("clears the idle timer when the flow ends first", async () => {
    const { flows, fakes, clock } = bed(createLoginFlows);
    flows.start("u1", "a", "oauth");
    expect(clock.pending()).toBe(1);
    fakes[0]?.fail(new PapError("helper_failed"));
    await settle();
    expect(clock.pending()).toBe(0);
  });
});

describe("what the flows remember", () => {
  it("keeps a bounded number of ended flows, forgetting the oldest in the publisher too", async () => {
    const { flows, fakes, forgotten } = bed(createLoginFlows);
    for (let i = 0; i < LOGIN_LIMITS.retained + 3; i++) {
      flows.start("u1", `p${i}`, "oauth");
      fakes[i]?.finish();
      await settle();
    }
    expect(forgotten).toEqual(["flow1", "flow2", "flow3"]);
    expect(() => flows.attach("u1", "flow1")).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(() => flows.attach("u1", "flow4")).not.toThrow();
  });

  it("lets a late subscriber of an ended flow attach", async () => {
    const { flows, fakes } = bed(createLoginFlows);
    const flowId = flows.start("u1", "a", "oauth");
    fakes[0]?.finish();
    await settle();
    expect(() => flows.attach("u1", flowId)).not.toThrow();
  });
});
