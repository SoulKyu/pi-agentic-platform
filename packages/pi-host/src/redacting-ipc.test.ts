import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Ipc, Outbound } from "./ipc.ts";
import { createRedactor, NO_REDACTOR, TOO_DEEP_TEXT } from "./policy/redact.ts";
import { clipText } from "./bounded.ts";
import { createRedactingIpc } from "./redacting-ipc.ts";
import { toExtensionErrorRecord } from "./wire-events.ts";

const redactor = createRedactor({ entries: [{ name: "GH", value: "ghp_testsecret_01" }] });
let stderr: string[];
beforeEach(() => {
  stderr = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => (stderr.push(String(chunk)), true));
});
afterEach(() => vi.restoreAllMocks());

function fakeIpc() {
  const records: Outbound[] = [];
  const ipc: Ipc = {
    send: (record) => (records.push(record), true),
    onMessage: () => () => {},
    onDisconnect: () => {},
  };
  return { ipc, records };
}

describe("the redacting ipc (M5R36)", () => {
  it.each([
    {
      type: "extension_error",
      extensionPath: "/ext/x.js",
      event: "agent_end",
      error: "boom ghp_testsecret_01",
    },
    { type: "extension_ui_request", id: "u", method: "notify", message: "token ghp_testsecret_01" },
    { type: "custom_render", id: "p", lines: ["a", "ghp_testsecret_01"] },
    {
      type: "approval_request",
      id: "a",
      category: "exec",
      title: "t",
      message: "echo ghp_testsecret_01",
      tool: "bash",
      key: "k".repeat(64),
      answers: ["deny", "once"],
      tainted: false,
    },
    { type: "response", id: "r", command: "get_state", success: false, error: "ghp_testsecret_01" },
    {
      type: "tool_execution_start",
      toolCallId: "c",
      toolName: "bash",
      args: { command: "echo ghp_testsecret_01" },
    },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ghp_testsecret_01" } },
  ])("redacts a $type record before it leaves", (record) => {
    const sent = fakeIpc();
    createRedactingIpc(sent.ipc, () => redactor).send(record);
    expect(JSON.stringify(sent.records)).not.toContain("ghp_testsecret_01");
    expect(JSON.stringify(sent.records)).toContain("[SECRET:GH]");
  });

  it("keeps the session file and id of ready as they are, and passes a record untouched without secrets", () => {
    const sent = fakeIpc();
    const ready = {
      type: "ready",
      sessionFile: "/home/ghp_testsecret_01/s.jsonl",
      sessionId: "s",
      piVersion: "1.1.0",
      leafId: null,
      sessionName: "ghp_testsecret_01",
    };
    createRedactingIpc(sent.ipc, () => redactor).send(ready);
    expect(sent.records[0]).toEqual({ ...ready, sessionName: "[SECRET:GH]" });
    const plain = { type: "health", rssMb: 10, descendants: 0 };
    createRedactingIpc(sent.ipc, () => NO_REDACTOR).send(plain);
    expect(sent.records[1]).toBe(plain);
  });

  it("drops a record it cannot check, says so on stderr, and answers a response with a failure under its id", () => {
    const sent = fakeIpc();
    const hostile = Object.defineProperty({ type: "extension_ui_request", id: "u" }, "message", {
      enumerable: true,
      get() {
        throw new Error("x");
      },
    });
    expect(createRedactingIpc(sent.ipc, () => redactor).send(hostile)).toBe(false);
    expect(sent.records).toEqual([]);
    expect(stderr).toEqual([
      "pi-host: a extension_ui_request record could not be checked for secrets (Error): dropped\n",
    ]);
    const response = Object.defineProperty(
      { type: "response", id: "r1", command: "compact", success: true },
      "data",
      {
        enumerable: true,
        get() {
          throw new Error("x");
        },
      },
    );
    createRedactingIpc(sent.ipc, () => redactor).send(response);
    expect(sent.records).toEqual([
      {
        type: "response",
        id: "r1",
        command: "compact",
        success: false,
        error: "record could not be checked",
      },
    ]);
  });

  it("replaces a too-deep subtree instead of dropping the record", () => {
    const sent = fakeIpc();
    const deep = Array.from({ length: 70 }).reduce<unknown>((inner) => ({ inner }), "ghp_testsecret_01");
    createRedactingIpc(sent.ipc, () => redactor).send({
      type: "tool_execution_end",
      toolCallId: "c",
      result: { content: [], details: deep },
    });
    expect(JSON.stringify(sent.records)).toContain(TOO_DEEP_TEXT);
    expect(JSON.stringify(sent.records)).not.toContain("ghp_testsecret_01");
  });

  it("masks the edges of a live output cut inside a secret (M5R120)", () => {
    const sent = fakeIpc();
    const update = (text: string) => ({
      type: "tool_execution_update",
      toolCallId: "c",
      toolName: "bash",
      args: {},
      partialResult: { content: [{ type: "text", text }], details: {} },
    });
    createRedactingIpc(sent.ipc, () => redactor).send(update("secret_01\nnext line"));
    createRedactingIpc(sent.ipc, () => redactor).send(update("output line\nghp_tests"));
    expect(sent.records.map((r) => (r as ReturnType<typeof update>).partialResult.content[0]?.text)).toEqual([
      "[SECRET:GH]\nnext line",
      "output line\n[SECRET:GH]",
    ]);
  });

  it("masks the end result of a tool the same way", () => {
    const sent = fakeIpc();
    createRedactingIpc(sent.ipc, () => redactor).send({
      type: "tool_execution_end",
      toolCallId: "c",
      result: { content: [{ type: "text", text: "more ghp_tests" }] },
    });
    expect(JSON.stringify(sent.records)).toContain("more [SECRET:GH]");
  });

  it("is hostile-input safe: a Map, a class, a cycle, a secret as a key and a toJSON are replaced, never thrown out of send", () => {
    const sent = fakeIpc();
    const out = createRedactingIpc(sent.ipc, () => redactor);
    class Holder {
      get secret(): string {
        throw new Error("getter");
      }
      visible = "ghp_testsecret_01";
    }
    const cycle: Record<string, unknown> = { type: "tool_execution_start", toolCallId: "c" };
    cycle.self = cycle;
    expect(out.send({ type: "x", map: new Map([["k", "ghp_testsecret_01"]]) })).toBe(true);
    expect(out.send({ type: "x", holder: new Holder() })).toBe(true);
    expect(out.send(cycle as Outbound)).toBe(true);
    expect(out.send({ type: "x", details: { ghp_testsecret_01: 1 } })).toBe(true);
    expect(out.send({ type: "x", details: { toJSON: () => "ghp_testsecret_01", n: 1 } })).toBe(true);
    expect(sent.records.slice(0, 2)).toEqual([
      { type: "x", map: {} },
      { type: "x", holder: { visible: "[SECRET:GH]" } },
    ]);
    expect(sent.records.slice(3)).toEqual([
      { type: "x", details: { "[SECRET:GH]": 1 } },
      { type: "x", details: { n: 1 } },
    ]);
    const looped = JSON.stringify(sent.records[2]);
    expect(looped.match(/"self":/g)).toHaveLength(32);
    expect(looped).toContain(TOO_DEEP_TEXT);
    expect(JSON.stringify(sent.records)).not.toContain("ghp_testsecret_01");
  });

  it("masks the end of a text another module clipped at 2000 characters, at every offset across the boundary", () => {
    const secret = "ghp_testsecret_01";
    for (let offset = 1976; offset <= 2000; offset++) {
      const sent = fakeIpc();
      const text = clipText("x".repeat(offset) + secret);
      createRedactingIpc(sent.ipc, () => redactor).send(
        toExtensionErrorRecord({ extensionPath: "/e.js", event: "e", error: text }),
      );
      const left = Math.max(0, 2000 - offset);
      // Whole: the exact pass. Cut with 4 to 16 characters left: the tail mask. Fewer than 4: at most 3 characters stay.
      const expected = "x".repeat(offset) + (left >= 4 ? "[SECRET:GH]" : secret.slice(0, left));
      expect(sent.records, `offset ${offset}`).toEqual([
        { type: "extension_error", extensionPath: "/e.js", event: "e", error: expected },
      ]);
    }
  });

  it("masks the cut end of a final result's line that Pi marked as truncated", () => {
    const sent = fakeIpc();
    createRedactingIpc(sent.ipc, () => redactor).send({
      type: "tool_execution_end",
      toolCallId: "c",
      result: { content: [{ type: "text", text: "a.ts:3: ghp_testsec... [truncated]\nb.ts:1: fine" }] },
    });
    expect(sent.records).toEqual([
      {
        type: "tool_execution_end",
        toolCallId: "c",
        result: { content: [{ type: "text", text: "a.ts:3: [SECRET:GH]... [truncated]\nb.ts:1: fine" }] },
      },
    ]);
  });

  it("reports the first, second and fourth unchecked record only, and answers every response", () => {
    const sent = fakeIpc();
    const out = createRedactingIpc(sent.ipc, () => redactor);
    const hostile = (id: string) =>
      Object.defineProperty({ type: "response", id, command: "compact", success: true }, "data", {
        enumerable: true,
        get() {
          throw new Error("x");
        },
      });
    for (let n = 1; n <= 5; n++) out.send(hostile(`r${n}`));
    expect(stderr).toHaveLength(3);
    expect(sent.records.map((r) => r.id)).toEqual(["r1", "r2", "r3", "r4", "r5"]);
  });

  it("reports a hostile type field without reading it twice or throwing", () => {
    const sent = fakeIpc();
    const record = Object.defineProperty({ message: "x" }, "type", {
      enumerable: true,
      get() {
        throw new Error("x");
      },
    });
    expect(() =>
      createRedactingIpc(sent.ipc, () => redactor).send(record as unknown as Outbound),
    ).not.toThrow();
    expect(sent.records).toEqual([]);
  });

  it("forwards the receive side untouched", () => {
    const calls: string[] = [];
    const base: Ipc = {
      send: () => true,
      onMessage: () => (calls.push("m"), () => calls.push("off")),
      onDisconnect: () => void calls.push("d"),
    };
    const wrapped = createRedactingIpc(base, () => redactor);
    wrapped.onDisconnect(() => {});
    wrapped.onMessage(() => {})();
    expect(calls).toEqual(["d", "m", "off"]);
  });
});
