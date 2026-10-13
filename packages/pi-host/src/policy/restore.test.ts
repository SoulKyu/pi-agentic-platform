import { describe, expect, it } from "vitest";
import { createRedactor } from "./redact.ts";
import { MCP_SOURCE, classifyTool } from "./tool-kind.ts";
import type { CallFacts } from "./pipeline.ts";
import { restoreInput, restoreMarkers, unrestoreInput } from "./restore.ts";

const values = new Map([["DB_TOKEN", "s3cr3t-Value-1"]]);

describe("restoreMarkers", () => {
  it("puts the value back for a known name and leaves an unknown one", () => {
    expect(restoreMarkers("pw=[SECRET:DB_TOKEN] [SECRET:NOPE] [SECRET:DB_TOKEN]", values)).toEqual({
      text: "pw=s3cr3t-Value-1 [SECRET:NOPE] s3cr3t-Value-1",
      count: 2,
    });
  });

  it("is linear on a text of unterminated markers", () => {
    const text = "[SECRET:".repeat(200_000);
    const started = Date.now();
    expect(restoreMarkers(text, values)).toEqual({ text, count: 0 });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it.each(["[SECRET:]", "[SECRET:a-b]", `[SECRET:${"a".repeat(65)}]`, "[secret:DB_TOKEN]"])(
    "never restores %s, a marker that is not ours",
    (text) => {
      expect(
        restoreMarkers(
          text,
          new Map([
            ["DB_TOKEN", "v"],
            ["a".repeat(65), "v"],
            ["a-b", "v"],
            ["", "v"],
          ]),
        ),
      ).toEqual({
        text,
        count: 0,
      });
    },
  );

  it("does not scan the value it put in", () => {
    expect(restoreMarkers("[SECRET:GH]", new Map([["GH", "[SECRET:GH]x1"]]))).toEqual({
      text: "[SECRET:GH]x1",
      count: 1,
    });
  });
});

const call = (toolName: string, input: unknown, path = `builtin:${toolName}`): CallFacts =>
  ({ event: { toolCallId: "c", toolName, input }, kind: classifyTool(toolName, { path }) }) as CallFacts;

describe("restoreInput", () => {
  it("restores write content and the edit texts, top level and listed", () => {
    const write = { path: "a", content: "x=[SECRET:DB_TOKEN]" };
    expect(restoreInput(call("write", write), values)).toBe(1);
    expect(write.content).toBe("x=s3cr3t-Value-1");
    const edit = {
      path: "a",
      oldText: "[SECRET:DB_TOKEN]",
      edits: [{ oldText: "[SECRET:DB_TOKEN]", newText: "[SECRET:DB_TOKEN][SECRET:DB_TOKEN]" }],
    };
    expect(restoreInput(call("edit", edit), values)).toBe(4);
    expect(edit.oldText).toBe("s3cr3t-Value-1");
    expect(edit.edits[0]?.newText).toBe("s3cr3t-Value-1s3cr3t-Value-1");
  });

  it("touches no other tool and no other field", () => {
    const other = { content: "[SECRET:DB_TOKEN]", path: "[SECRET:DB_TOKEN]", command: "[SECRET:DB_TOKEN]" };
    for (const [name, path] of [
      ["bash", "builtin:bash"],
      ["mcp__x__save", MCP_SOURCE],
      ["write", "/ext/w.js"],
      ["read", "builtin:read"],
    ] as const)
      expect(restoreInput(call(name, other, path), values)).toBe(0);
    expect(restoreInput(call("write", other), values)).toBe(1);
    expect(other.path).toBe("[SECRET:DB_TOKEN]");
    expect(other.command).toBe("[SECRET:DB_TOKEN]");
  });

  it("restores a megabyte of markers, every one counted", () => {
    const write = { content: "[SECRET:DB_TOKEN]".repeat(Math.ceil(1_048_576 / 17)) };
    const n = Math.ceil(1_048_576 / 17);
    expect(restoreInput(call("write", write), values)).toBe(n);
    expect(write.content).toBe("s3cr3t-Value-1".repeat(n));
  });

  it("undoes a restoration, and a frozen input that holds a marker throws without changing anything", () => {
    const edit = { oldText: "[SECRET:DB_TOKEN]", edits: [{ newText: "[SECRET:DB_TOKEN]" }] };
    const facts = call("edit", edit);
    restoreInput(facts, values);
    unrestoreInput(facts);
    expect(edit).toEqual({ oldText: "[SECRET:DB_TOKEN]", edits: [{ newText: "[SECRET:DB_TOKEN]" }] });
    const half = { oldText: "[SECRET:DB_TOKEN]", edits: [Object.freeze({ newText: "[SECRET:DB_TOKEN]" })] };
    expect(() => restoreInput(call("edit", half), values)).toThrow(TypeError);
    expect(half.oldText).toBe("[SECRET:DB_TOKEN]");
  });

  it("ignores an input that is not a plain object", () => {
    for (const input of [null, "[SECRET:DB_TOKEN]", ["[SECRET:DB_TOKEN]"], 3])
      expect(restoreInput(call("write", input), values)).toBe(0);
    const getter = Object.defineProperty({}, "content", {
      enumerable: true,
      get: () => {
        throw new Error("no");
      },
    });
    expect(restoreInput(call("write", getter), values)).toBe(0);
  });
});

describe("documented limit: a secret with a quote or a backslash inside a JSON file", () => {
  it("is shown as a marker in its escaped form and written back unescaped, so the file differs (known, Task 26)", () => {
    const value = 'ab"cd\\ef-12345';
    const redactor = createRedactor({ entries: [{ name: "J", value }] });
    const original = `{"k":"${JSON.stringify(value).slice(1, -1)}"}`;
    const seen = redactor.text(original).text;
    expect(seen).toBe('{"k":"[SECRET:J]"}');
    const back = restoreMarkers(seen, redactor.restorable()).text;
    expect(back).toBe(`{"k":"${value}"}`);
    expect(back).not.toBe(original);
  });

  it("restores only the secrets the redactor lists as restorable: a provider credential keeps its marker", () => {
    const redactor = createRedactor({
      entries: [
        { name: "ENV", value: "env-value-123" },
        { name: "AUTH_OPENAI_ACCESS", value: "auth-value-123", restorable: false },
      ],
    });
    expect(restoreMarkers("[SECRET:ENV] [SECRET:AUTH_OPENAI_ACCESS]", redactor.restorable())).toEqual({
      text: "env-value-123 [SECRET:AUTH_OPENAI_ACCESS]",
      count: 1,
    });
  });
});
