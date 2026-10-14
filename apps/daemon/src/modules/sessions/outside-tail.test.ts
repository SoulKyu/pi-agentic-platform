import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_TAIL_BYTES, tailHoldsToolResults } from "./outside-tail.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-tail-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const entry = (message: object) => `${JSON.stringify({ type: "message", id: "e", message })}\n`;
const HEAD = '{"type":"session"}\n';
const fileWith = (text: string) => {
  const path = join(dir, "s.jsonl");
  writeFileSync(path, HEAD + text);
  return path;
};

describe("tailHoldsToolResults (MC19 c)", () => {
  it("is false when nothing was added, or only user and assistant text", () => {
    const path = fileWith(entry({ role: "user", content: "hi" }));
    expect(tailHoldsToolResults(path, HEAD.length)).toBe(false);
    expect(tailHoldsToolResults(path, HEAD.length + entry({ role: "user", content: "hi" }).length)).toBe(
      false,
    );
    appendFileSync(path, entry({ role: "assistant", content: [] }));
    expect(tailHoldsToolResults(path, HEAD.length)).toBe(false);
  });

  it("is true for a toolResult message after `from`, and false when it lies before `from`", () => {
    const result = entry({ role: "toolResult", content: [] });
    const path = fileWith(result);
    expect(tailHoldsToolResults(path, HEAD.length)).toBe(true);
    expect(tailHoldsToolResults(path, HEAD.length + result.length)).toBe(false);
  });

  it("is true for anything it cannot read", () => {
    expect(tailHoldsToolResults(fileWith("not json\n"), HEAD.length)).toBe(true);
    expect(tailHoldsToolResults(fileWith("[1]\n"), HEAD.length)).toBe(true);
    expect(tailHoldsToolResults(fileWith('{"type":"message"'), HEAD.length)).toBe(true);
    expect(tailHoldsToolResults(fileWith(""), HEAD.length + 1)).toBe(true);
    expect(tailHoldsToolResults(join(dir, "missing.jsonl"), 0)).toBe(true);
  });

  it("is true for a directory and for a symlink, which it never follows", () => {
    mkdirSync(join(dir, "d"));
    expect(tailHoldsToolResults(join(dir, "d"), 0)).toBe(true);
    const real = fileWith(entry({ role: "user", content: "hi" }));
    symlinkSync(real, join(dir, "link.jsonl"));
    expect(tailHoldsToolResults(join(dir, "link.jsonl"), HEAD.length)).toBe(true);
  });

  it("is true for more unread bytes than it will parse", () => {
    const path = join(dir, "big.jsonl");
    const blank = Buffer.alloc(MAX_TAIL_BYTES + 1, 0x20);
    blank[blank.length - 1] = 0x0a;
    writeFileSync(path, blank);
    expect(tailHoldsToolResults(path, 0)).toBe(true);
    expect(tailHoldsToolResults(path, 1)).toBe(false);
  });
});
