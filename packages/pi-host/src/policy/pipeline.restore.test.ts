import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createPipelineBed } from "../testing/pipeline-bed.ts";
import { grantKey, grantPayload } from "./grant-key.ts";
import { FAIL_CLOSED_REASON } from "./pipeline.ts";
import { MCP_SOURCE } from "./tool-kind.ts";

let bed: Awaited<ReturnType<typeof createPipelineBed>>;
beforeAll(async () => {
  bed = await createPipelineBed();
});
afterAll(() => bed.dispose());
afterEach(() => vi.restoreAllMocks());

const secretValues = { GH: "ghp_abcdefgh" };

describe("markers restored into built-in writes (M5R119)", () => {
  it("restores markers into a built-in write's content and an edit's texts, and audits the marker, never the value", async () => {
    const h = bed.harness({ secretValues });
    const write = { path: join(bed.cwd, "a.txt"), content: "TOKEN=[SECRET:GH]\n" };
    expect(await h.run("write", write)).toBeUndefined();
    expect(write.content).toBe("TOKEN=ghp_abcdefgh\n");
    const entry = h.entries.at(-1);
    expect(entry).toMatchObject({ decision: "allow", args: expect.stringContaining("[SECRET:GH]") });
    expect(JSON.stringify(entry)).not.toContain("ghp_abcdefgh");
    expect(entry?.kind === "call" && entry.stages.at(-1)).toEqual({
      stage: "06",
      outcome: "acted",
      reason: "1 secret marker restored",
    });
    const edit = {
      path: join(bed.cwd, "a.txt"),
      edits: [{ oldText: "TOKEN=[SECRET:GH]", newText: "TOKEN=[SECRET:GH]\nX=1" }],
    };
    await h.run("edit", edit);
    expect(edit.edits[0]).toEqual({ oldText: "TOKEN=ghp_abcdefgh", newText: "TOKEN=ghp_abcdefgh\nX=1" });
  });

  it("asks about the marker, not the value", async () => {
    const h = bed.harness({ secretValues });
    await h.run("write", { path: join(bed.outside, "q.txt"), content: "[SECRET:GH]" });
    expect(h.asked.join("\n")).toContain("[SECRET:GH]");
    expect(h.asked.join("\n")).not.toContain("ghp_abcdefgh");
  });

  it("never restores into a command, an MCP or extension input, a built-in name registered elsewhere, or a call that does not run", async () => {
    const tools = { mcp__x__save: { path: MCP_SOURCE }, write: { path: "/ext/w.js" } };
    const h = bed.harness({ secretValues, tools: { ...tools, bash: { path: "builtin:bash" } } });
    const inputs = [
      ["bash", { command: "echo [SECRET:GH]" }],
      ["mcp__x__save", { content: "[SECRET:GH]" }],
      ["write", { path: join(bed.cwd, "b.txt"), content: "[SECRET:GH]" }],
    ] as const;
    for (const [tool, input] of inputs) {
      await h.run(tool, input);
      expect(JSON.stringify(input)).toContain("[SECRET:GH]");
    }
    const denied = bed.harness({ secretValues, answers: [{ answer: "deny", closed: false }] });
    const outside = { path: join(bed.outside, "c.txt"), content: "[SECRET:GH]" };
    await denied.run("write", outside);
    expect(outside.content).toBe("[SECRET:GH]");
  });

  it("a value that holds a marker is written once and not scanned again", async () => {
    const h = bed.harness({ secretValues: { GH: "[SECRET:GH]x1" } });
    const write = { path: join(bed.cwd, "d.txt"), content: "[SECRET:GH]" };
    await h.run("write", write);
    expect(write.content).toBe("[SECRET:GH]x1");
  });

  it("restores a megabyte of markers and counts every one", async () => {
    const n = 90_000;
    const h = bed.harness({ secretValues });
    const write = { path: join(bed.cwd, "e.txt"), content: "[SECRET:GH]".repeat(n) };
    await h.run("write", write);
    expect(write.content).toBe("ghp_abcdefgh".repeat(n));
    expect(h.entries.at(-1)?.kind === "call" && h.entries.at(-1)?.stages.at(-1)?.reason).toBe(
      `${n} secret markers restored`,
    );
  });

  it("leaves markers that are not ours alone", async () => {
    const h = bed.harness({ secretValues });
    const content = `[SECRET:] [SECRET:a-b] [SECRET:${"a".repeat(65)}] [secret:GH]`;
    const write = { path: join(bed.cwd, "f.txt"), content };
    await h.run("write", write);
    expect(write.content).toBe(content);
    expect(h.entries.at(-1)?.kind === "call" && h.entries.at(-1)?.stages.at(-1)?.stage).toBe("04");
  });

  it("puts the marker back and blocks when the audit line cannot be written, so a blocked call keeps no value", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const audit = vi.fn(() => {
      throw new Error("sink down");
    });
    const h = bed.harness({ secretValues, audit });
    const write = { path: join(bed.cwd, "g.txt"), content: "[SECRET:GH]" };
    expect(await h.run("write", write)).toMatchObject({ block: true });
    expect(write.content).toBe("[SECRET:GH]");
  });

  it("puts the marker back and blocks when the commit step throws", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const h = bed.harness({
      secretValues,
      stages: {
        commit: () => {
          throw new Error("guard down");
        },
      },
    });
    const write = { path: join(bed.cwd, "h.txt"), content: "[SECRET:GH]" };
    expect(await h.run("write", write)).toEqual({ block: true, reason: FAIL_CLOSED_REASON });
    expect(write.content).toBe("[SECRET:GH]");
  });

  it("judges, asks and audits on the marker: the redaction only ever sees the marker, the key is the marker's", async () => {
    const seen: string[] = [];
    const h = bed.harness({
      secretValues,
      redact: (text) => (seen.push(text), text),
    });
    const inside = { path: join(bed.cwd, "i.txt"), content: "TOKEN=[SECRET:GH]\n" };
    await h.run("write", inside);
    expect(inside.content).toBe("TOKEN=ghp_abcdefgh\n");
    expect(seen.join("")).toContain("[SECRET:GH]");
    expect(seen.join("")).not.toContain("ghp_abcdefgh");
    expect(h.entries.at(-1)).toMatchObject({
      args: JSON.stringify({ content: "TOKEN=[SECRET:GH]\n", path: join(bed.cwd, "i.txt") }),
    });
    const markerInput = { path: join(bed.outside, "o.txt"), content: "TOKEN=[SECRET:GH]\n" };
    await h.run("write", structuredClone(markerInput), "c2");
    expect(h.asks[0]?.key).toBe(grantKey("write", grantPayload(markerInput, false)));
    expect(h.asks[0]?.message).not.toContain("ghp_abcdefgh");
  });

  it("blocks, with nothing restored, when the restore stage itself throws", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const h = bed.harness({
      secretValues,
      stages: {
        restore: () => {
          throw new Error("restore down");
        },
      },
    });
    const write = { path: join(bed.cwd, "t.txt"), content: "[SECRET:GH]" };
    expect(await h.run("write", write)).toEqual({ block: true, reason: FAIL_CLOSED_REASON });
    expect(write.content).toBe("[SECRET:GH]");
    expect(h.entries.at(-1)).toMatchObject({ decision: "block", reason: "evaluation error" });
  });
});
