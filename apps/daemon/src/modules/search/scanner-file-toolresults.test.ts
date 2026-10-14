import { appendFileSync, writeFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { openSearchIndex } from "./index-db.ts";
import { createSearchIndexStore, type SearchIndexStore } from "./index-store.ts";
import { processFile } from "./scanner-file.ts";
import { MAX_LINE_BYTES } from "./session-file.ts";
import type { FakeScanPort } from "./testing/fake-scan-port.ts";
import { assistant, header, piFile, useScannerBed, user } from "./testing/scanner-bed.ts";

const bed = useScannerBed({ openSearchIndex, createSearchIndexStore, processFile });
const { file, run } = bed;
let store: SearchIndexStore;
let port: FakeScanPort;
beforeEach(() => {
  ({ store, port } = bed);
});

const toolResult = (id: string, text = "out") =>
  JSON.stringify({ type: "message", id, message: { role: "toolResult", content: [{ type: "text", text }] } });
const flags = () => port.touched.map((t) => t.toolResults);

describe("touched carries toolResults (decision 75 Q5, M7R27)", () => {
  it("is true only for tool results read on from a stored cursor", () => {
    const path = file("a.jsonl", piFile(header(), user("e1", "one"), toolResult("t0")));
    run(path); // a first index: the history of the file, never a tool result added since
    appendFileSync(path, `${assistant("e2", "two")}\n`);
    run(path);
    appendFileSync(path, `${toolResult("t1")}\n`);
    run(path);
    expect(flags()).toEqual([false, false, true]);
  });

  it("stays true for a later step of a multi-step read whose file did not grow again", () => {
    const path = file("a.jsonl", piFile(header(), user("e0", "zero")));
    run(path);
    const filler = Array.from({ length: 6 }, (_, i) => user(`f${i}`, `message ${i} ${"x".repeat(150)}`));
    appendFileSync(path, `${[...filler, toolResult("t1")].join("\n")}\n`);
    port.touched.length = 0;
    for (let i = 0; i < 20; i++) {
      const outcome = run(path, { stepBytes: 300 });
      if (outcome.kind !== "indexed" || !outcome.more) break;
    }
    expect(flags()).toEqual([false, false, false, true]);
  });

  it("is true for a line that cannot be read as an entry (fail closed)", () => {
    const path = file("a.jsonl", piFile(header(), user("e1", "one")));
    run(path);
    appendFileSync(path, "{ this is not json\n");
    run(path);
    expect(flags()).toEqual([false, true]);
  });

  it("is true for a line over the size cap, which is never parsed", () => {
    const path = file("a.jsonl", piFile(header(), user("e1", "one")));
    run(path);
    appendFileSync(path, `${toolResult("t1", "y".repeat(MAX_LINE_BYTES + 10))}\n`);
    run(path);
    expect(flags()).toEqual([false, true]);
  });

  it("is true when the file was replaced and holds tool results", () => {
    const path = file("a.jsonl", piFile(header(), user("e1", "one")));
    run(path);
    writeFileSync(path, piFile(header("other"), user("f1", "uno"), toolResult("t1")));
    run(path);
    expect(flags()).toEqual([false, true]);
  });

  it("is false for a rebuilt index that reads the whole file again", () => {
    const path = file("a.jsonl", piFile(header(), user("e1", "one"), toolResult("t1")));
    run(path);
    store.forget(path);
    run(path);
    expect(flags()).toEqual([false, false]);
  });

  it("waits for the end of a half-written line, then reports it", () => {
    const path = file("a.jsonl", piFile(header(), user("e1", "one")));
    run(path);
    const line = toolResult("t1");
    appendFileSync(path, line.slice(0, 20));
    run(path);
    appendFileSync(path, `${line.slice(20)}\n`);
    run(path);
    expect(flags()).toEqual([false, true]);
  });

  it("keeps its position when the port throws on tool results, and tells the port again on the next pass", () => {
    const path = file("a.jsonl", piFile(header(), user("e1", "one")));
    run(path);
    const before = store.cursor(path);
    appendFileSync(path, `${toolResult("t1")}\n`);
    const failing = {
      ...port.port,
      touched: () => {
        throw Object.assign(new Error("policy down"), { code: "EIO" });
      },
    };
    expect(processFile(path, bed.context(undefined, { sessions: failing }))).toEqual({
      kind: "skipped",
      reason: "port_failed",
    });
    expect(store.cursor(path)).toEqual(before);
    expect(store.rowCount()).toBe(1);
    port.touched.length = 0;
    expect(run(path)).toMatchObject({ kind: "indexed" });
    expect(flags()).toEqual([true]);
    expect(store.rowCount()).toBe(1);
  });

  it("asks the port before it saves the position, for tool results only", () => {
    const path = file("a.jsonl", piFile(header(), user("e1", "one")));
    run(path);
    appendFileSync(path, `${toolResult("t1")}\n`);
    const seen: Array<number | undefined> = [];
    const watching = {
      ...port.port,
      touched: () => void seen.push(store.cursor(path)?.offset),
    };
    const before = store.cursor(path)?.offset;
    processFile(path, bed.context(undefined, { sessions: watching }));
    expect(seen).toEqual([before]);
  });
});
