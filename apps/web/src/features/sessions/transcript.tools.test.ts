import { afterEach, describe, expect, it } from "vitest";
import { setLocale, t } from "../../i18n/index.ts";
import { EMPTY_VIEW, reduceSession, type SessionView, type ToolView } from "../../stores/session-reducer.ts";
import { sessionSnapshot } from "../../testing/session-snapshot.ts";
import { transcriptItems, type TranscriptItem } from "./transcript.vm.ts";

const rowsOf = (view: Parameters<typeof transcriptItems>[0]) => transcriptItems(view, t);

afterEach(() => setLocale("en"));

type Row = readonly [entryId: string | null, message: unknown];

function viewWith(rows: readonly Row[], tools: Record<string, ToolView> = {}): SessionView {
  const view = reduceSession(
    EMPTY_VIEW,
    sessionSnapshot({ rows: rows.map(([entryId, message]) => ({ entryId, message })) }),
  );
  return { ...view, tools: new Map(Object.entries(tools)) };
}
const call = (id: string, name: string, args: unknown) => ({ type: "toolCall", id, name, arguments: args });
const assistant = (content: unknown[], timestamp: number) => ({ role: "assistant", content, timestamp });
const result = (toolCallId: string, text: string, extra: object = {}) => ({
  role: "toolResult",
  toolCallId,
  content: [{ type: "text", text }],
  timestamp: 9,
  ...extra,
});
const tools = (items: TranscriptItem[]) => items.filter((item) => item.kind === "tool");

describe("transcriptItems: tool calls", () => {
  it("pairs each tool call with its result and the tool's live status", () => {
    const view = viewWith(
      [
        ["a1", assistant([{ type: "text", text: "Reading." }, call("c1", "read", { path: "a.txt" })], 1)],
        ["t1", result("c1", "x".repeat(8000), { papTruncated: { chars: 30000 } })],
        ["a2", assistant([call("c2", "bash", { command: "make" })], 2)],
      ],
      { c2: { name: "bash", status: "running", preview: "building…" } },
    );
    const items = rowsOf(view);
    expect(items.map((item) => [item.kind, item.key])).toEqual([
      ["message", "assistant:1"],
      ["tool", "a1:c1#0"],
      ["tool", "a2:c2#0"],
    ]);
    expect(items[1]).toMatchObject({
      name: "read",
      summary: '{"path":"a.txt"}',
      status: "done",
      truncatedChars: 30000,
      toolCallId: "c1",
      resultEntryId: "t1",
    });
    expect(items[2]).toMatchObject({
      status: "running",
      preview: "building…",
      summary: "make",
      resultEntryId: null,
    });
  });

  it("keeps two calls that reuse one id apart, each with its own result and status (M2-RT-11)", () => {
    const view = viewWith(
      [
        ["a1", assistant([call("c", "bash", { command: "echo one" })], 1)],
        ["t1", result("c", "one")],
        [
          "a2",
          assistant(
            [call("c", "bash", { command: "echo two" }), call("c", "bash", { command: "echo three" })],
            2,
          ),
        ],
        ["t2", result("c", "two", { isError: true })],
      ],
      { c: { name: "bash", status: "running", preview: "three…" } },
    );
    expect(tools(rowsOf(view)).map((item) => [item.key, item.summary, item.status, item.preview])).toEqual([
      ["a1:c#0", "echo one", "done", "one"],
      ["a2:c#0", "echo two", "failed", "two"],
      ["a2:c#1", "echo three", "running", "three…"],
    ]);
  });

  it("pairs an id a provider reuses on every turn with the call of its own turn", () => {
    const view = viewWith([
      ["a1", assistant([call("call_0", "read", { path: "1" })], 1)],
      ["t1", result("call_0", "first")],
      ["a2", assistant([call("call_0", "read", { path: "2" })], 2)],
      ["t2", result("call_0", "second")],
      ["a3", assistant([call("call_0", "read", { path: "3" })], 3)],
    ]);
    expect(tools(rowsOf(view)).map((item) => [item.key, item.preview, item.status])).toEqual([
      ["a1:call_0#0", "first", "done"],
      ["a2:call_0#0", "second", "done"],
      ["a3:call_0#0", "", "waiting"],
    ]);
  });

  it("pairs a result with the nearest turn that asked, and leaves an older unanswered call waiting", () => {
    const view = viewWith([
      ["a1", assistant([call("c", "bash", { command: "never answered" })], 1)],
      ["a2", assistant([call("c", "bash", { command: "answered" })], 2)],
      ["t2", result("c", "its output")],
    ]);
    expect(tools(rowsOf(view)).map((item) => [item.key, item.status, item.preview])).toEqual([
      ["a1:c#0", "waiting", ""],
      ["a2:c#0", "done", "its output"],
    ]);
  });

  it("gives the live status only to the newest unanswered call of an id; older ones wait", () => {
    const view = viewWith(
      [
        ["a1", assistant([call("c", "bash", { command: "one" })], 1)],
        ["a2", assistant([call("c", "bash", { command: "two" })], 2)],
      ],
      { c: { name: "bash", status: "running", preview: "live" } },
    );
    expect(tools(rowsOf(view)).map((item) => [item.key, item.status, item.preview])).toEqual([
      ["a1:c#0", "waiting", ""],
      ["a2:c#0", "running", "live"],
    ]);
  });

  it("a result with no call before it is a line of its own and never takes a later call (orphan)", () => {
    const view = viewWith(
      [
        ["t0", result("z", "orphan text")],
        ["a1", assistant([call("z", "bash", { command: "later" })], 1)],
      ],
      { z: { name: "bash", status: "running", preview: "live" } },
    );
    expect(
      rowsOf(view).map((item) => [item.kind, item.key, item.kind === "tool" ? item.status : null]),
    ).toEqual([
      ["message", "toolResult:z", null],
      ["tool", "a1:z#0", "running"],
    ]);
    expect(rowsOf(view)[0]).toMatchObject({ author: "tool", text: "orphan text" });
  });

  it("falls back to the message key as owner while Pi has not written the entry", () => {
    const view = viewWith([[null, assistant([call("c", "bash", { command: "ls" })], 7)]]);
    expect(tools(rowsOf(view)).map((item) => item.key)).toEqual(["assistant:7:c#0"]);
  });

  it("clips the argument summary and says it was cut", () => {
    const view = viewWith([["a1", assistant([call("c", "write", { text: "y".repeat(5000) })], 1)]]);
    const [item] = tools(rowsOf(view));
    expect(item?.summary.length).toBe(201);
    expect(item?.argsTruncated).toBe(true);
    expect(tools(rowsOf(viewWith([["a", assistant([call("d", "x", { n: 1 })], 1)]])))[0]?.argsTruncated).toBe(
      false,
    );
  });

  it("clips the name and the id of a call", () => {
    const view = viewWith([["a1", assistant([call("i".repeat(400), "n".repeat(200), {})], 1)]]);
    const [item] = tools(rowsOf(view));
    expect(item?.name).toBe(`${"n".repeat(64)}…`);
    expect(item?.toolCallId).toBe(`${"i".repeat(256)}…`);
  });

  it("closes the call of a result that was too big to send, with its size", () => {
    const view = viewWith([
      ["a1", assistant([call("c", "bash", { command: "cat big" })], 1)],
      ["t1", { role: "toolResult", toolCallId: "c", timestamp: 2, omitted: true, bytes: 300_000 }],
    ]);
    expect(rowsOf(view)).toMatchObject([
      { kind: "tool", status: "done", preview: "", omittedBytes: 300_000, resultEntryId: "t1" },
    ]);
    expect(rowsOf(view)).toHaveLength(1);
  });

  it("keeps every key unique even when a tool key would equal a message key", () => {
    const view = viewWith([
      ["assistant", assistant([call("5", "a", {}), call("5", "a", {})], 5)],
      [null, assistant([{ type: "text", text: "dup" }], 5)],
      [null, assistant([], 5)],
    ]);
    const keys = rowsOf(view).map((item) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("leaves a result that failed to carry its call id out of every call", () => {
    const view = viewWith([
      ["a1", assistant([call("c", "bash", { command: "ls" })], 1)],
      ["t1", { role: "toolResult", content: [{ type: "text", text: "no id" }], timestamp: 2 }],
    ]);
    expect(tools(rowsOf(view)).map((item) => item.status)).toEqual(["waiting"]);
  });
});
