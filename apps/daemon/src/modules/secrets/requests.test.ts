import { PLATFORM_RESULTS } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlatformRefusal } from "../platform/index.ts";
import { papCode } from "../agents/testing/requests-bed.ts";
import { ONCE_LIMITS, refHash, refOf, SECRET_REF } from "./refs.ts";
import { SECRET_WAIT_MS } from "./requests.ts";
import { disposeBeds, MIN, SALT, setup, VALUE } from "./testing/secret-requests-bed.ts";

afterEach(disposeBeds);

describe("secret.request: the op (M11R103)", () => {
  it("opens a secret request with the name as title and the stripped reason as detail, and waits", async () => {
    const s = await setup();
    const { t } = s;
    const call = s.ask({ reason: "to read the dashboards" });
    await t.bed.clock.advance(0);
    const row = t.bed.db.get<Record<string, unknown>>(
      "SELECT kind, title, detail, session_id, expires_at, ref_hash FROM agent_requests WHERE id = $id",
      { id: s.pendingId() },
    );
    expect(row).toEqual({
      kind: "secret",
      title: "GRAFANA_TOKEN",
      detail: "to read the dashboards",
      session_id: "t1",
      expires_at: t.bed.clock.now() + SECRET_WAIT_MS,
      ref_hash: null,
    });
    expect(t.upserts).toEqual([
      {
        kind: "secret_request",
        refId: s.pendingId(),
        agentId: t.agentId,
        detail: "GRAFANA_TOKEN",
        toHandle: true,
      },
    ]);
    expect(call.settled).toEqual({});
  });

  it("answers sandbox_unavailable before any request opens when the agent's sandbox is off (RT-17)", async () => {
    const s = await setup({ sandboxed: false });
    const { t } = s;
    const call = s.ask();
    await expect(call.promise).rejects.toMatchObject({ code: "sandbox_unavailable" });
    expect(t.bed.db.all("SELECT id FROM agent_requests")).toEqual([]);
    expect(t.upserts).toEqual([]);
    expect(t.changed).toEqual([]);
  });

  it("refuses a call with no agent (not_found) and opens nothing when already aborted (cancelled)", async () => {
    const s = await setup();
    const { t } = s;
    await expect(s.ask({}, { agentId: null }).promise).rejects.toBeInstanceOf(PlatformRefusal);
    const controller = new AbortController();
    controller.abort();
    await expect(s.ask({}, {}, controller).promise).rejects.toMatchObject({ code: "cancelled" });
    expect(t.upserts).toEqual([]);
  });

  it("refuses a fourth open secret request of the agent with limit_reached", async () => {
    const s = await setup();
    const { t } = s;
    const calls = [s.ask(), s.ask(), s.ask()];
    await t.bed.clock.advance(0);
    await expect(s.ask().promise).rejects.toMatchObject({ code: "limit_reached" });
    for (const call of calls) call.controller.abort();
    await t.bed.clock.advance(0);
  });

  it("answers timeout after 30 minutes and marks the request expired", async () => {
    const s = await setup();
    const { t } = s;
    const call = s.ask();
    await t.bed.clock.advance(0);
    const id = s.pendingId();
    await t.bed.clock.advance(29 * MIN);
    expect(call.settled).toEqual({});
    await t.bed.clock.advance(MIN);
    await expect(call.promise).rejects.toMatchObject({ code: "timeout" });
    expect(t.stateOf(id)?.state).toBe("expired");
    expect(t.resolved.at(-1)).toMatchObject({ refId: id, resolution: "timed_out" });
    expect(t.bed.clock.pending()).toBe(0);
  });

  it("ends the wait when the op's signal aborts: cancelled, the item resolved, nothing left", async () => {
    const s = await setup();
    const { t } = s;
    const call = s.ask();
    await t.bed.clock.advance(0);
    const id = s.pendingId();
    call.controller.abort();
    await expect(call.promise).rejects.toMatchObject({ code: "cancelled" });
    expect(t.stateOf(id)?.state).toBe("cancelled");
    expect(t.bed.clock.pending()).toBe(0);
    // An answer after that finds nothing (the owner's card is closed too).
    expect(
      await papCode(() =>
        s.secretRequests.answer(t.bed.owner(), { requestId: id, value: VALUE, mode: "once" }),
      ),
    ).toBe("not_found");
    expect(s.once.size()).toBe(0);
  });
});

describe("answering with the vault (M11R105)", () => {
  it("saves the value under the agent's scope, tells the live workers, and gives the agent a ref and the mode", async () => {
    const s = await setup();
    const { t } = s;
    const call = s.ask();
    await t.bed.clock.advance(0);
    const id = s.pendingId();
    s.secretRequests.answer(t.bed.owner(), { requestId: id, value: VALUE, mode: "vault" });
    const result = await call.promise;
    expect(PLATFORM_RESULTS["secret.request"].parse(result)).toEqual({
      ref: refOf(SALT, id),
      name: "GRAFANA_TOKEN",
      mode: "vault",
    });
    expect(s.vault.reveal("u1", { kind: "agent", agentId: t.agentId })).toEqual({ GRAFANA_TOKEN: VALUE });
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toMatchObject({ agentId: t.agentId, record: { type: "vault_update", once: [] } });
    expect(s.sent[0]?.record.vault).toEqual({ GRAFANA_TOKEN: VALUE });
    expect(s.once.size()).toBe(0);
    expect(t.stateOf(id)?.state).toBe("answered");
    expect(t.resolved.at(-1)).toMatchObject({ refId: id, resolution: "answered" });
  });

  it("keeps the ref's hash in the row and never the ref", async () => {
    const s = await setup();
    const { t } = s;
    const call = s.ask();
    await t.bed.clock.advance(0);
    const id = s.pendingId();
    s.secretRequests.answer(t.bed.owner(), { requestId: id, value: VALUE, mode: "vault" });
    const { ref } = (await call.promise) as { ref: string };
    expect(ref).toMatch(SECRET_REF);
    const row = t.bed.db.get<{ ref_hash: string }>("SELECT ref_hash FROM agent_requests WHERE id = $id", {
      id,
    });
    expect(row?.ref_hash).toBe(refHash(ref));
    expect(JSON.stringify(t.bed.db.all("SELECT * FROM agent_requests"))).not.toContain(ref);
  });
});

describe("answering for one use (M11R105)", () => {
  it("writes nothing to the vault and sends the value to the asking session's worker only", async () => {
    const s = await setup();
    const { t } = s;
    const call = s.ask();
    await t.bed.clock.advance(0);
    const id = s.pendingId();
    s.secretRequests.answer(t.bed.owner(), { requestId: id, value: VALUE, mode: "once" });
    const result = (await call.promise) as { mode: string; ref: string };
    expect(result).toMatchObject({ mode: "once", name: "GRAFANA_TOKEN" });
    expect(s.vault.reveal("u1", { kind: "agent", agentId: t.agentId })).toEqual({});
    expect(s.vault.names("u1", { kind: "agent", agentId: t.agentId })).toEqual([]);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]?.sessionId).toBe("t1");
    expect(s.sent[0]?.record).toEqual({
      type: "vault_update",
      vault: {},
      once: [
        {
          id: expect.any(String),
          name: "GRAFANA_TOKEN",
          value: VALUE,
          expiresAt: t.bed.clock.now() + ONCE_LIMITS.ttlMs,
        },
      ],
    });
    expect(s.once.forSession("t1")).toEqual([
      {
        id: expect.any(String),
        name: "GRAFANA_TOKEN",
        value: VALUE,
        expiresAt: t.bed.clock.now() + ONCE_LIMITS.ttlMs,
      },
    ]);
    expect(t.bed.auditRows().some((row) => row.reason === "secret set")).toBe(false);
  });

  it("every update carries the session's full list: the second answer lists both values (W5-R37)", async () => {
    const s = await setup();
    const { t } = s;
    for (const name of ["A_ONE", "B_TWO"]) {
      const call = s.ask({ name });
      await t.bed.clock.advance(0);
      s.secretRequests.answer(t.bed.owner(), {
        requestId: s.pendingId(),
        value: `${VALUE}-${name}`,
        mode: "once",
      });
      await call.promise;
    }
    expect(s.sent.map((each) => each.record.once.map((entry) => entry.name))).toEqual([
      ["A_ONE"],
      ["A_ONE", "B_TWO"],
    ]);
  });

  it("N1: the same token answered again is a new entry with its own id, and so are two waiting answers with one value", async () => {
    const s = await setup();
    const { t } = s;
    for (let n = 0; n < 2; n += 1) {
      const call = s.ask();
      await t.bed.clock.advance(0);
      s.secretRequests.answer(t.bed.owner(), { requestId: s.pendingId(), value: VALUE, mode: "once" });
      await call.promise;
    }
    const held = s.once.forSession("t1");
    expect(held.map((entry) => entry.value)).toEqual([VALUE, VALUE]);
    expect(new Set(held.map((entry) => entry.id)).size).toBe(2);
    expect(s.sent.at(-1)?.record.once.map((entry) => entry.id)).toEqual(held.map((entry) => entry.id));
    // A report for one id deletes that entry alone, and a repeat deletes nothing more.
    expect(s.once.used("t1", held[0]?.id ?? "")).toBe(true);
    expect(s.once.used("t1", held[0]?.id ?? "")).toBe(false);
    expect(s.once.forSession("t1").map((entry) => entry.id)).toEqual([held[1]?.id]);
  });

  it("builds and parses the record before anything is kept: a record that does not parse leaves nothing held (M1)", async () => {
    const s = await setup();
    const { t } = s;
    const call = s.ask();
    await t.bed.clock.advance(0);
    const id = s.pendingId();
    vi.spyOn(s.secrets, "vaultOf").mockReturnValue({ lower: "x" });
    expect(
      await papCode(() =>
        s.secretRequests.answer(t.bed.owner(), { requestId: id, value: VALUE, mode: "once" }),
      ),
    ).toBe("internal");
    expect(s.once.size()).toBe(0);
    expect(s.warnings).toEqual([["secret_once_record_invalid"]]);
    expect(t.bed.auditRows().filter((row) => row.reason === "secret answer")).toEqual([]);
    expect(s.sent).toEqual([]);
    expect(t.stateOf(id)?.state).toBe("pending");
    call.controller.abort();
  });

  it("the live vault travels with the update, so a one-use answer never empties the worker's vault", async () => {
    const s = await setup();
    const { t } = s;
    s.vault.set("u1", { kind: "agent", agentId: t.agentId }, "SAVED_NAME", "saved-value-12345678", 1);
    const call = s.ask();
    await t.bed.clock.advance(0);
    s.secretRequests.answer(t.bed.owner(), { requestId: s.pendingId(), value: VALUE, mode: "once" });
    await call.promise;
    expect(s.sent[0]?.record.vault).toEqual({ SAVED_NAME: "saved-value-12345678" });
  });

  it("refuses a fourth waiting value of the agent with limit_reached and keeps the request open", async () => {
    const s = await setup();
    const { t } = s;
    for (const name of ["A_ONE", "B_TWO", "C_THREE"]) {
      const call = s.ask({ name });
      await t.bed.clock.advance(0);
      s.secretRequests.answer(t.bed.owner(), {
        requestId: s.pendingId(),
        value: `${VALUE}-${name}`,
        mode: "once",
      });
      await call.promise;
    }
    const fourth = s.ask({ name: "D_FOUR" });
    await t.bed.clock.advance(0);
    const id = s.pendingId();
    expect(
      await papCode(() =>
        s.secretRequests.answer(t.bed.owner(), { requestId: id, value: VALUE, mode: "once" }),
      ),
    ).toBe("limit_reached");
    expect(t.stateOf(id)?.state).toBe("pending");
    expect(s.once.size()).toBe(3);
    expect(fourth.settled).toEqual({});
    fourth.controller.abort();
  });

  it("deleting the agent drops its waiting values (dropAgent)", async () => {
    const s = await setup();
    const { t } = s;
    t.bed.agents.setLinks({ onceValues: { drop: (_owner, agentId) => void s.once.dropAgent(agentId) } });
    const call = s.ask();
    await t.bed.clock.advance(0);
    s.secretRequests.answer(t.bed.owner(), { requestId: s.pendingId(), value: VALUE, mode: "once" });
    await call.promise;
    expect(s.once.size()).toBe(1);
    await t.bed.agents.remove(t.bed.owner(), t.agentId);
    expect(s.once.size()).toBe(0);
  });
});
