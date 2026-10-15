import { describe, expect, it } from "vitest";
import { scrubKnownSecrets } from "../audit/index.ts";
import { runLine } from "./export-jsonl.ts";
import type { RunRow } from "./store.ts";

const row: RunRow = {
  id: "run-1",
  ownerId: "u1",
  workspaceId: "default",
  sessionId: "s1",
  taskId: "t1",
  origin: "trigger",
  status: "completed",
  startedAt: Date.UTC(2026, 9, 14, 12, 0, 0),
  endedAt: Date.UTC(2026, 9, 14, 12, 0, 30),
  provider: "anthropic",
  model: "claude-sonnet",
  billing: "subscription",
  inputTokens: 1,
  outputTokens: 2,
  cacheReadTokens: 3,
  cacheWriteTokens: 4,
  costUsd: 0.125,
  turns: 2,
  toolCalls: 5,
  errorClass: null,
  limitResetAt: null,
};
const line = (patch: Partial<RunRow> = {}) => runLine({ ...row, ...patch }, scrubKnownSecrets);

describe("the runs.jsonl line", () => {
  it("has exactly the documented keys and values", () => {
    expect(JSON.parse(line())).toEqual({
      v: 1,
      ts: "2026-10-14T12:00:30.000Z",
      id: "run-1",
      ownerId: "u1",
      sessionId: "s1",
      taskId: "t1",
      origin: "trigger",
      status: "completed",
      startedAt: Date.UTC(2026, 9, 14, 12, 0, 0),
      endedAt: Date.UTC(2026, 9, 14, 12, 0, 30),
      durationMs: 30_000,
      provider: "anthropic",
      model: "claude-sonnet",
      billing: "subscription",
      tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
      costUsd: 0.125,
      turns: 2,
      toolCalls: 5,
      errorClass: null,
      limitResetAt: null,
    });
  });

  it("is one line without a line break, whatever the fields hold", () => {
    const text = line({ sessionId: "a\nb\r\u2028\u2029c", taskId: "x\ny", origin: "o\nk" });
    expect(text).not.toMatch(/[\n\r\u2028\u2029]/);
    expect(JSON.parse(text)).toHaveProperty("sessionId");
  });

  it("carries no key that could hold content", () => {
    const keys = Object.keys(JSON.parse(line()) as object);
    for (const forbidden of ["prompt", "text", "cwd", "path", "message", "error", "errorMessage", "args"])
      expect(keys).not.toContain(forbidden);
  });

  it("stays under 1 KiB when a row somehow carries a megabyte of text", () => {
    const huge = "z".repeat(1_000_000);
    const text = line({
      sessionId: huge,
      taskId: huge,
      origin: huge,
      ownerId: huge,
      id: huge,
    } as Partial<RunRow>);
    expect(Buffer.byteLength(text)).toBeLessThan(1024);
  });

  it("writes a model id that holds an API key or a quote as other", () => {
    const keyed = JSON.parse(line({ model: "sk-" + "a".repeat(30) })) as { model: string };
    expect(keyed.model).toBe("other");
    const quoted = JSON.parse(line({ provider: 'x"y', model: 'm"' })) as { provider: string; model: string };
    expect(quoted).toMatchObject({ provider: "other", model: "other" });
  });

  it("writes none for a run without a model", () => {
    expect(JSON.parse(line({ provider: null, model: null }))).toMatchObject({
      provider: "none",
      model: "none",
    });
  });

  it("carries the end class and the reset time of a limited run", () => {
    expect(
      JSON.parse(line({ status: "limited", errorClass: "usage_limit", limitResetAt: 99 })),
    ).toMatchObject({
      status: "limited",
      errorClass: "usage_limit",
      limitResetAt: 99,
    });
  });

  it("refuses a row that has not ended", () => {
    expect(() => line({ endedAt: null, status: "running" })).toThrow();
  });
});
