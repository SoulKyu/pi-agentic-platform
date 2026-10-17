import { afterEach, describe, expect, it } from "vitest";
import { agentInput } from "./testing/bed.ts";
import { createRequestsBed, papCode, refusalCode, type RequestsBed } from "./testing/requests-bed.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { testCaller } from "../../testing/caller.ts";

let t: RequestsBed;
afterEach(() => t.bed.dispose());

describe("opening a request (M11R101)", () => {
  it("writes a pending row, a to-handle Inbox item keyed by the request id, and tells the stream", async () => {
    t = await createRequestsBed();
    const id = t.requests.open(t.input({ detail: "Runs the migration." }));
    expect(t.stateOf(id)).toEqual({ state: "pending", answered_at: null });
    expect(t.upserts).toEqual([
      { kind: "agent_approve", refId: id, agentId: t.agentId, detail: "Deploy to prod?", toHandle: true },
    ]);
    expect(t.changed).toEqual([{ ownerId: "u1", requestId: id }]);
    const row = t.bed.db.get<{ detail: string; session_id: string; expires_at: number }>(
      "SELECT detail, session_id, expires_at FROM agent_requests WHERE id = $id",
      { id },
    );
    expect(row).toEqual({
      detail: "Runs the migration.",
      session_id: "t1",
      expires_at: t.bed.clock.now() + 60_000,
    });
  });

  it("files a secret request under the secret_request item kind", async () => {
    t = await createRequestsBed();
    const id = t.requests.open(t.input({ kind: "secret" }));
    expect(t.upserts[0]).toMatchObject({ kind: "secret_request", refId: id, toHandle: true });
  });

  it("allows 4 open approvals and 3 open secret requests per agent, and refuses the next with limit_reached", async () => {
    t = await createRequestsBed();
    for (let n = 0; n < 4; n += 1) t.requests.open(t.input());
    expect(refusalCode(() => t.requests.open(t.input()))).toBe("limit_reached");
    for (let n = 0; n < 3; n += 1) t.requests.open(t.input({ kind: "secret" }));
    expect(refusalCode(() => t.requests.open(t.input({ kind: "secret" })))).toBe("limit_reached");
    const count = t.bed.db.get<{ n: number }>("SELECT count(*) AS n FROM agent_requests")?.n;
    expect(count).toBe(7);
    // Another agent is not affected, and a closed request frees its place.
    const other = await t.bed.agents.create(t.bed.owner(), agentInput({ name: "Scout" }));
    expect(refusalCode(() => t.requests.open(t.input({ agentId: other.id })))).toBe("none");
    const first =
      t.bed.db.get<{ id: string }>("SELECT id FROM agent_requests WHERE kind = 'approve'")?.id ?? "";
    t.requests.cancel(first);
    expect(refusalCode(() => t.requests.open(t.input()))).toBe("none");
  });

  it("refuses an agent that is not the owner's with not_found and writes nothing", async () => {
    t = await createRequestsBed();
    expect(refusalCode(() => t.requests.open(t.input({ ownerId: "u2" })))).toBe("not_found");
    expect(refusalCode(() => t.requests.open(t.input({ agentId: "nobody-0000" })))).toBe("not_found");
    expect(t.upserts).toEqual([]);
  });

  it("strips hidden characters from the title and the detail, clips them, and refuses a title with nothing left", async () => {
    t = await createRequestsBed();
    const id = t.requests.open(
      t.input({ title: `Pay\u202E now\u200B${"x".repeat(600)}`, detail: `a\u2028b${"y".repeat(1100)}` }),
    );
    const row = t.bed.db.get<{ title: string; detail: string }>(
      "SELECT title, detail FROM agent_requests WHERE id = $id",
      { id },
    );
    expect(row?.title).toBe(`Pay now${"x".repeat(493)}`);
    expect(row?.detail).toBe(`a b${"y".repeat(997)}`);
    expect(refusalCode(() => t.requests.open(t.input({ title: "\u200B\u202E" })))).toBe("bad_request");
  });
});

describe("answering (M11R102)", () => {
  it("approve closes the row, resolves the item as answered, tells the stream and wakes the waiter", async () => {
    t = await createRequestsBed();
    const id = t.requests.open(t.input());
    const waiting = t.requests.wait(id);
    await t.requests.answer(t.bed.owner(), id, true);
    expect(await waiting).toBe("approved");
    expect(t.stateOf(id)).toEqual({ state: "approved", answered_at: t.bed.clock.now() });
    expect(t.resolved).toEqual([{ ownerId: "u1", kind: "agent_approve", refId: id, resolution: "answered" }]);
    expect(t.changed.at(-1)).toEqual({ ownerId: "u1", requestId: id });
  });

  it("deny closes the row as denied", async () => {
    t = await createRequestsBed();
    const id = t.requests.open(t.input());
    await t.requests.answer(t.bed.owner(), id, false);
    expect(await t.requests.wait(id)).toBe("denied");
    expect(t.stateOf(id)?.state).toBe("denied");
  });

  it("audits the answer without the agent's words", async () => {
    t = await createRequestsBed();
    const id = t.requests.open(t.input({ title: "SECRET-TITLE" }));
    await t.requests.answer(t.bed.owner(), id, true);
    const rows = t.bed.auditRows().filter((row) => row.reason === "agent approval");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: "user", kind: "policy", reason: "agent approval" });
    expect(JSON.parse(rows[0]?.detail ?? "")).toEqual({ agentId: t.agentId, requestId: id, approved: true });
  });

  it("answers not_found for a closed request, another owner's, a secret request and an unknown id", async () => {
    t = await createRequestsBed();
    const id = t.requests.open(t.input());
    const secret = t.requests.open(t.input({ kind: "secret" }));
    expect(await papCode(() => t.requests.answer(testCaller({ userId: "u2" }), id, true))).toBe("not_found");
    expect(await papCode(() => t.requests.answer(t.bed.owner(), secret, true))).toBe("not_found");
    expect(await papCode(() => t.requests.answer(t.bed.owner(), "nope", true))).toBe("not_found");
    await t.requests.answer(t.bed.owner(), id, true);
    expect(await papCode(() => t.requests.answer(t.bed.owner(), id, false))).toBe("not_found");
    expect(t.stateOf(id)?.state).toBe("approved");
    expect(t.stateOf(secret)?.state).toBe("pending");
  });

  it("answers forbidden to a token and leaves the request open", async () => {
    t = await createRequestsBed();
    const id = t.requests.open(t.input());
    const token = testCaller({ kind: "token", credentialId: "tok1" });
    expect(await papCode(() => t.requests.answer(token, id, true))).toBe("forbidden");
    expect(t.stateOf(id)?.state).toBe("pending");
    expect(t.bed.auditRows().filter((row) => row.reason === "agent approval")).toEqual([]);
  });

  it("answers read_only on a database a newer pap wrote", async () => {
    t = await createRequestsBed({ readOnly: true });
    expect(await papCode(() => t.requests.answer(t.bed.owner(), "any", true))).toBe("read_only");
  });
});

describe("closing without an answer", () => {
  it("expire marks expired and resolves the item as timed out; a second close does nothing", async () => {
    t = await createRequestsBed();
    const id = t.requests.open(t.input());
    const waiting = t.requests.wait(id);
    expect(t.requests.expire(id)).toBe(true);
    expect(await waiting).toBe("expired");
    expect(t.stateOf(id)?.state).toBe("expired");
    expect(t.resolved).toEqual([
      { ownerId: "u1", kind: "agent_approve", refId: id, resolution: "timed_out" },
    ]);
    expect(t.requests.cancel(id)).toBe(false);
    expect(t.stateOf(id)?.state).toBe("expired");
  });

  it("cancel marks cancelled and closes the item with no resolution", async () => {
    t = await createRequestsBed();
    const id = t.requests.open(t.input());
    expect(t.requests.cancel(id)).toBe(true);
    expect(await t.requests.wait(id)).toBe("cancelled");
    expect(t.resolved).toEqual([{ ownerId: "u1", kind: "agent_approve", refId: id, resolution: null }]);
  });

  it("wait on a request that is already closed returns its state at once", async () => {
    t = await createRequestsBed();
    const id = t.requests.open(t.input());
    t.requests.expire(id);
    expect(await t.requests.wait(id)).toBe("expired");
    expect(await t.requests.wait("unknown")).toBe("cancelled");
  });
});

describe("boot", () => {
  it("expires every request still pending: the call that waited for it died with the daemon", async () => {
    t = await createRequestsBed();
    const a = t.requests.open(t.input());
    const b = t.requests.open(t.input({ kind: "secret" }));
    const done = t.requests.open(t.input());
    t.requests.cancel(done);
    t.resolved.length = 0;
    t.changed.length = 0;
    t.build();
    expect(t.stateOf(a)?.state).toBe("expired");
    expect(t.stateOf(b)?.state).toBe("expired");
    expect(t.stateOf(done)?.state).toBe("cancelled");
    expect(t.resolved).toHaveLength(2);
    expect(t.resolved).toEqual(
      expect.arrayContaining([
        { ownerId: "u1", kind: "agent_approve", refId: a, resolution: "timed_out" },
        { ownerId: "u1", kind: "secret_request", refId: b, resolution: "timed_out" },
      ]),
    );
    expect(t.changed.map((entry) => entry.requestId).sort()).toEqual([a, b].sort());
  });

  it("leaves a read-only database alone", async () => {
    t = await createRequestsBed();
    const id = t.requests.open(t.input());
    const { createRequests } = await import("./requests.ts");
    createRequests({
      db: t.bed.db,
      clock: t.bed.clock,
      logger: silentLogger,
      items: { upsertAgentItem: () => true, resolveRef: () => true },
      audit: t.bed.audit,
      changed: () => {},
      readOnly: true,
    });
    expect(t.stateOf(id)?.state).toBe("pending");
  });
});

describe("closing everything an agent waits for (quarantine, M11R115)", () => {
  it("cancels the agent's pending requests of both kinds, resolves their items and tells the stream, others untouched", async () => {
    t = await createRequestsBed();
    const other = await t.bed.agents.create(t.bed.owner(), agentInput({ name: "Scout" }));
    const a = t.requests.open(t.input());
    const b = t.requests.open(t.input({ kind: "secret" }));
    const kept = t.requests.open(t.input({ agentId: other.id }));
    const answered = t.requests.open(t.input());
    t.requests.cancel(answered);
    t.changed.length = 0;
    t.resolved.length = 0;
    const waiting = t.requests.wait(a);
    expect(t.requests.cancelAllOf("u1", t.agentId)).toBe(2);
    expect(t.stateOf(a)?.state).toBe("cancelled");
    expect(t.stateOf(b)?.state).toBe("cancelled");
    expect(t.stateOf(kept)?.state).toBe("pending");
    await expect(waiting).resolves.toBe("cancelled");
    expect(t.resolved.map((entry) => entry.refId).sort()).toEqual([a, b].sort());
    expect(t.changed.map((entry) => entry.requestId).sort()).toEqual([a, b].sort());
    expect(t.requests.cancelAllOf("u1", t.agentId)).toBe(0);
  });

  it("closes nothing of another owner's agent and nothing on a read-only database", async () => {
    t = await createRequestsBed();
    const id = t.requests.open(t.input());
    expect(t.requests.cancelAllOf("u2", t.agentId)).toBe(0);
    expect(t.stateOf(id)?.state).toBe("pending");
    const { createRequests } = await import("./requests.ts");
    const frozen = createRequests({
      db: t.bed.db,
      clock: t.bed.clock,
      logger: silentLogger,
      items: { upsertAgentItem: () => true, resolveRef: () => true },
      audit: t.bed.audit,
      changed: () => {},
      readOnly: true,
    });
    expect(frozen.cancelAllOf("u1", t.agentId)).toBe(0);
    expect(t.stateOf(id)?.state).toBe("pending");
  });
});
