import { PapError, type ShellSession } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import type { QueryRow } from "./query.ts";
import { createSearchService } from "./service.ts";

const row = (patch: Partial<QueryRow> = {}): QueryRow => ({
  sessionId: "s1",
  entryId: "e1",
  role: "user",
  at: 10,
  snippet: "about \u0002kube\u0003rnetes",
  ...patch,
});

const session = (id: string): ShellSession => ({
  id,
  cwd: "/w",
  name: null,
  preview: null,
  status: "idle",
  needsInput: false,
  projectId: null,
  pinRank: null,
  archivedAt: null,
  settledAt: null,
  snoozedUntil: null,
  createdAt: 1,
  updatedAt: 2,
});

function setup(rows: QueryRow[], summary: (id: string, owner: string) => ShellSession | null = session) {
  const query = vi.fn(async () => rows);
  const summaryFn = vi.fn(summary);
  return {
    service: createSearchService({ client: { query }, sessions: { summary: summaryFn } }),
    query,
    summaryFn,
  };
}

describe("search service", () => {
  it("passes the match expression, the caller's id and the default limit to the client", async () => {
    const { service, query } = setup([]);
    await service.query(testCaller(), { q: "kube" });
    expect(query).toHaveBeenCalledWith({ match: '"kube"*', ownerId: "u1", limit: 20 });
  });

  it("passes a given limit", async () => {
    const { service, query } = setup([]);
    await service.query(testCaller({ userId: "u7" }), { q: "kube", limit: 5 });
    expect(query).toHaveBeenCalledWith({ match: '"kube"*', ownerId: "u7", limit: 5 });
  });

  it("answers a hit with the session summary", async () => {
    const { service, summaryFn } = setup([row()]);
    const { hits } = await service.query(testCaller(), { q: "kube" });
    expect(hits).toEqual([
      {
        sessionId: "s1",
        entryId: "e1",
        role: "user",
        at: 10,
        snippet: "about \u0002kube\u0003rnetes",
        session: session("s1"),
      },
    ]);
    expect(summaryFn).toHaveBeenCalledWith("s1", "u1");
  });

  it("drops a row whose session is not the caller's or is gone", async () => {
    const { service } = setup([row({ sessionId: "gone" }), row({ sessionId: "s2", entryId: "e2" })], (id) =>
      id === "gone" ? null : session(id),
    );
    const { hits } = await service.query(testCaller(), { q: "kube" });
    expect(hits.map((hit) => hit.sessionId)).toEqual(["s2"]);
  });

  it("cuts a 500-unit snippet to 400 without a lone surrogate", async () => {
    const snippet = `${"a".repeat(399)}\u{1F469}${"b".repeat(100)}`;
    const { service } = setup([row({ snippet })]);
    const { hits } = await service.query(testCaller(), { q: "kube" });
    expect(hits[0]?.snippet).toBe("a".repeat(399));
  });

  it("cuts a plain 500-unit snippet to exactly 400 units", async () => {
    const { service } = setup([row({ snippet: "x".repeat(500) })]);
    const { hits } = await service.query(testCaller(), { q: "kube" });
    expect(hits[0]?.snippet).toBe("x".repeat(400));
  });

  it("drops rows the contract cannot carry and keeps the valid one (RT-22)", async () => {
    const { service } = setup([
      row({ at: -1, entryId: "bad-at" }),
      row({ entryId: "x".repeat(129) }),
      row({ role: "tool" as unknown as "user", entryId: "bad-role" }),
      row({ entryId: "good" }),
    ]);
    const { hits } = await service.query(testCaller(), { q: "kube" });
    expect(hits.map((hit) => hit.entryId)).toEqual(["good"]);
  });

  it("answers no hits without calling the client for a query with no word", async () => {
    const { service, query } = setup([row()]);
    await expect(service.query(testCaller(), { q: "*()" })).resolves.toEqual({ hits: [] });
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects with the client's timeout", async () => {
    const query = vi.fn(async () => {
      throw new PapError("timeout");
    });
    const service = createSearchService({ client: { query }, sessions: { summary: session } });
    await expect(service.query(testCaller(), { q: "kube" })).rejects.toMatchObject({ code: "timeout" });
  });
});
