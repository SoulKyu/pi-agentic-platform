import { PapError } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { papCode } from "../agents/testing/requests-bed.ts";
import { disposeBeds, setup, dumpOf, VALUE } from "./testing/secret-requests-bed.ts";

afterEach(disposeBeds);

describe("what the owner may do", () => {
  it("refuses a token (forbidden) and leaves the request open", async () => {
    const s = await setup();
    const { t } = s;
    const call = s.ask();
    await t.bed.clock.advance(0);
    const id = s.pendingId();
    const token = testCaller({ kind: "token", credentialId: "tok1" });
    expect(
      await papCode(() => s.secretRequests.answer(token, { requestId: id, value: VALUE, mode: "once" })),
    ).toBe("forbidden");
    expect(await papCode(() => s.secretRequests.decline(token, { requestId: id }))).toBe("forbidden");
    expect(t.stateOf(id)?.state).toBe("pending");
    expect(s.once.size()).toBe(0);
    expect(call.settled).toEqual({});
    call.controller.abort();
  });

  it("answers not_found for another owner's request, a closed one, an approval, and a ref used as an id", async () => {
    const s = await setup();
    const { t } = s;
    const call = s.ask();
    await t.bed.clock.advance(0);
    const id = s.pendingId();
    const other = testCaller({ userId: "u2" });
    expect(
      await papCode(() => s.secretRequests.answer(other, { requestId: id, value: VALUE, mode: "once" })),
    ).toBe("not_found");
    expect(await papCode(() => s.secretRequests.decline(other, { requestId: id }))).toBe("not_found");
    s.secretRequests.answer(t.bed.owner(), { requestId: id, value: VALUE, mode: "once" });
    const { ref } = (await call.promise) as { ref: string };
    // Replay of the same answer, and a guess with the ref the agent holds: nothing resolves a ref.
    expect(
      await papCode(() =>
        s.secretRequests.answer(t.bed.owner(), { requestId: id, value: VALUE, mode: "once" }),
      ),
    ).toBe("not_found");
    expect(
      await papCode(() =>
        s.secretRequests.answer(t.bed.owner(), { requestId: ref, value: VALUE, mode: "once" }),
      ),
    ).toBe("not_found");
    expect(s.once.size()).toBe(1);
    const approval = t.requests.open(t.input());
    expect(
      await papCode(() =>
        s.secretRequests.answer(t.bed.owner(), { requestId: approval, value: VALUE, mode: "once" }),
      ),
    ).toBe("not_found");
  });

  it("refuses a name the vault refuses with bad_request and the request stays pending", async () => {
    const s = await setup();
    const { t } = s;
    // Opened below the schema, as a damaged row would be: the answer checks the name again.
    const id = t.requests.open(t.input({ kind: "secret", title: "PATH", detail: "hijack" }));
    for (const mode of ["vault", "once"] as const) {
      expect(
        await papCode(() => s.secretRequests.answer(t.bed.owner(), { requestId: id, value: VALUE, mode })),
      ).toBe("bad_request");
      expect(t.stateOf(id)?.state).toBe("pending");
    }
    expect(s.vault.reveal("u1", { kind: "agent", agentId: t.agentId })).toEqual({});
    expect(s.once.size()).toBe(0);
    expect(s.sent).toEqual([]);
  });

  it("refuses a value the vault refuses (bad_request) and keeps the request open", async () => {
    const s = await setup();
    const { t } = s;
    const call = s.ask();
    await t.bed.clock.advance(0);
    const id = s.pendingId();
    for (const value of ["", "a\0b", "x".repeat(4097)])
      expect(
        await papCode(() => s.secretRequests.answer(t.bed.owner(), { requestId: id, value, mode: "vault" })),
      ).toBe("bad_request");
    expect(t.stateOf(id)?.state).toBe("pending");
    call.controller.abort();
  });

  it("a decline closes the request and the agent gets refused", async () => {
    const s = await setup();
    const { t } = s;
    const call = s.ask();
    await t.bed.clock.advance(0);
    const id = s.pendingId();
    s.secretRequests.decline(t.bed.owner(), { requestId: id });
    await expect(call.promise).rejects.toMatchObject({ code: "refused" });
    expect(t.stateOf(id)?.state).toBe("declined");
    expect(t.resolved.at(-1)).toMatchObject({ refId: id, resolution: "answered" });
    expect(s.once.size()).toBe(0);
    expect(t.bed.clock.pending()).toBe(0);
  });
});

describe("no value anywhere (RT-03)", () => {
  it("is in no result, row, audit line, log line, item, stream notice or warning, whatever the mode", async () => {
    const s = await setup();
    const { t } = s;
    for (const mode of ["vault", "once"] as const) {
      const call = s.ask({ name: mode === "vault" ? "SAVED_TOKEN" : "ONCE_TOKEN" });
      await t.bed.clock.advance(0);
      s.secretRequests.answer(t.bed.owner(), { requestId: s.pendingId(), value: `${VALUE}-${mode}`, mode });
      expect(JSON.stringify(await call.promise)).not.toContain(VALUE);
    }
    const dump = dumpOf(s);
    expect(dump).not.toContain(VALUE);
    expect(dump).not.toContain(Buffer.from(VALUE).toString("base64"));
    const audit = t.bed.auditRows().filter((row) => row.reason === "secret answer");
    expect(audit.map((row) => JSON.parse(row.detail))).toEqual([
      { agentId: t.agentId, requestId: expect.any(String), name: "SAVED_TOKEN", mode: "vault" },
      { agentId: t.agentId, requestId: expect.any(String), name: "ONCE_TOKEN", mode: "once" },
    ]);
  });

  it("audits before it keeps the value: a failing audit refuses the answer, logs it without the value, and keeps nothing", async () => {
    for (const mode of ["once", "vault"] as const) {
      const s = await setup({ auditFails: true });
      const { t } = s;
      const call = s.ask();
      await t.bed.clock.advance(0);
      const id = s.pendingId();
      expect(
        await papCode(() => s.secretRequests.answer(t.bed.owner(), { requestId: id, value: VALUE, mode })),
      ).toBe("internal");
      expect(s.warnings).toEqual([["secret_audit_failed", { errorClass: "Error" }]]);
      expect(JSON.stringify(s.warnings)).not.toContain(VALUE);
      expect(t.stateOf(id)?.state).toBe("pending");
      expect(s.once.size()).toBe(0);
      expect(s.sent).toEqual([]);
      expect(s.vault.reveal("u1", { kind: "agent", agentId: t.agentId })).toEqual({});
      expect(call.settled).toEqual({});
      call.controller.abort();
      disposeBeds();
    }
  });

  it("writes the audit row before the value is kept", async () => {
    const s = await setup();
    const { t } = s;
    const call = s.ask();
    await t.bed.clock.advance(0);
    const id = s.pendingId();
    let rowsWhenKept = -1;
    const put = s.once.put.bind(s.once);
    vi.spyOn(s.once, "put").mockImplementation((...args) => {
      rowsWhenKept = t.bed.auditRows().filter((row) => row.reason === "secret answer").length;
      return put(...args);
    });
    s.secretRequests.answer(t.bed.owner(), { requestId: id, value: VALUE, mode: "once" });
    await call.promise;
    expect(rowsWhenKept).toBe(1);
  });

  it("a vault keep that fails leaves the answer row and one failure row with the code only", async () => {
    const s = await setup();
    const { t } = s;
    const call = s.ask();
    await t.bed.clock.advance(0);
    const id = s.pendingId();
    vi.spyOn(s.secrets, "set").mockImplementation(() => {
      throw new PapError("limit_reached");
    });
    expect(
      await papCode(() =>
        s.secretRequests.answer(t.bed.owner(), { requestId: id, value: VALUE, mode: "vault" }),
      ),
    ).toBe("limit_reached");
    const rows = t.bed.auditRows().filter((row) => row.reason.startsWith("secret answer"));
    expect(rows.map((row) => row.reason)).toEqual(["secret answer", "secret answer failed"]);
    expect(JSON.parse(rows[1]?.detail ?? "")).toEqual({
      agentId: t.agentId,
      requestId: id,
      code: "limit_reached",
    });
    expect(JSON.stringify(rows)).not.toContain(VALUE);
    expect(t.stateOf(id)?.state).toBe("pending");
    call.controller.abort();
  });

  it("refuses a fourth waiting value before it audits anything", async () => {
    const s = await setup();
    const { t } = s;
    for (let n = 0; n < 3; n += 1) {
      const call = s.ask({ name: `TOKEN_${n}` });
      await t.bed.clock.advance(0);
      s.secretRequests.answer(t.bed.owner(), { requestId: s.pendingId(), value: VALUE, mode: "once" });
      await call.promise;
    }
    const call = s.ask({ name: "TOKEN_4" });
    await t.bed.clock.advance(0);
    const id = s.pendingId();
    const before = t.bed.auditRows().filter((row) => row.reason === "secret answer").length;
    expect(
      await papCode(() =>
        s.secretRequests.answer(t.bed.owner(), { requestId: id, value: VALUE, mode: "once" }),
      ),
    ).toBe("limit_reached");
    expect(t.bed.auditRows().filter((row) => row.reason === "secret answer")).toHaveLength(before);
    expect(t.stateOf(id)?.state).toBe("pending");
    call.controller.abort();
  });

  it("the audit row exists by the time the request is closed", async () => {
    const s = await setup();
    const { t } = s;
    const call = s.ask();
    await t.bed.clock.advance(0);
    const id = s.pendingId();
    const seen: string[] = [];
    const original = t.requests.closeSecret;
    const spy = vi.spyOn(t.requests, "closeSecret").mockImplementation((...args) => {
      seen.push(...t.bed.auditRows().map((row) => row.reason));
      return original(...args);
    });
    s.secretRequests.answer(t.bed.owner(), { requestId: id, value: VALUE, mode: "once" });
    await call.promise;
    expect(seen).toContain("secret answer");
    spy.mockRestore();
  });
});
