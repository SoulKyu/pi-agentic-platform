import type { UiResponseRecord } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createUiBridge, type UiOutbound } from "./ui-bridge.ts";

function setup(options: { failSend?: (record: UiOutbound) => boolean } = {}) {
  const sent: UiOutbound[] = [];
  const timers: Array<() => void> = [];
  const cleared: unknown[] = [];
  let next = 0;
  const bridge = createUiBridge(
    (record) => {
      if (options.failSend?.(record)) throw new Error("ipc closed");
      sent.push(record);
      return true;
    },
    {
      newId: () => `u${++next}`,
      setTimer: (fn) => timers.push(fn),
      clearTimer: (handle) => cleared.push(handle),
    },
  );
  return { bridge, sent, timers, cleared };
}

const respond = (fields: Record<string, unknown>) =>
  ({ type: "extension_ui_response", ...fields }) as UiResponseRecord;

describe("extension UI bridge", () => {
  it("emits a confirm request and resolves with the answer", async () => {
    const { bridge, sent } = setup();
    const answer = bridge.context.confirm("Run a command?", "bash: ls");
    expect(sent).toEqual([
      {
        type: "extension_ui_request",
        id: "u1",
        method: "confirm",
        title: "Run a command?",
        message: "bash: ls",
      },
    ]);
    bridge.resolve({ type: "extension_ui_response", id: "u1", confirmed: true });
    expect(await answer).toBe(true);
    expect(bridge.pendingCount()).toBe(0);
  });

  it("resolves a cancelled dialog with its fallback", async () => {
    const { bridge, sent } = setup();
    const choice = bridge.context.select("Pick", ["a", "b"]);
    bridge.resolve({ type: "extension_ui_response", id: "u1", cancelled: true });
    expect(await choice).toBeUndefined();
    expect(sent.map((r) => r.type)).toEqual(["extension_ui_request"]);
  });

  it("closes a dialog on timeout or abort and tells the daemon", async () => {
    const { bridge, sent, timers } = setup();
    const timed = bridge.context.confirm("t", "m", { timeout: 1000 });
    timers[0]?.();
    expect(await timed).toBe(false);
    const controller = new AbortController();
    const aborted = bridge.context.input("Name?", undefined, { signal: controller.signal });
    controller.abort();
    expect(await aborted).toBeUndefined();
    expect(sent.filter((r) => r.type === "extension_ui_closed").map((r) => r.id)).toEqual(["u1", "u2"]);
    expect(bridge.pendingCount()).toBe(0);
  });

  it("cancelAll resolves every pending dialog", async () => {
    const { bridge } = setup();
    const a = bridge.context.confirm("a", "a");
    const b = bridge.context.editor("b", "text");
    expect(bridge.pendingCount()).toBe(2);
    bridge.cancelAll();
    expect([await a, await b]).toEqual([false, undefined]);
    expect(bridge.pendingCount()).toBe(0);
  });

  it("forwards decorations, renders component widgets and opens custom panels", async () => {
    const { bridge, sent } = setup();
    bridge.context.notify("hello", "warning");
    bridge.context.setStatus("ext", "busy");
    bridge.context.setWidget("w", ["line"]);
    bridge.context.setWidget("w2", (() => ({
      render: () => ["from a component"],
      invalidate: () => {},
    })) as never);
    expect(sent.map((r) => (r as { method?: string }).method)).toEqual([
      "notify",
      "setStatus",
      "setWidget",
      "setWidget",
    ]);
    expect(sent[3]).toMatchObject({ widgetKey: "w2", widgetLines: ["from a component"] });
    bridge.cancelAll();
  });

  it("opens a panel for custom() and closes it on cancelAll", async () => {
    const { bridge, sent } = setup();
    const result = bridge.context.custom(() => ({ render: () => ["panel"], invalidate: () => {} }) as never);
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent).toEqual([{ type: "custom_render", id: "u1", lines: ["panel"] }]);
    bridge.panelInput("u1", "k");
    bridge.cancelAll();
    expect(await result).toBeUndefined();
    expect(sent.at(-1)).toEqual({ type: "custom_close", id: "u1" });
  });

  it("clears a component widget when the key is set to lines or undefined", () => {
    const { bridge, sent } = setup();
    let disposed = 0;
    bridge.context.setWidget("w", (() => ({ render: () => ["a"], dispose: () => disposed++ })) as never);
    bridge.context.setWidget("w", ["plain"]);
    expect(disposed).toBe(1);
    expect(sent.at(-1)).toMatchObject({ widgetKey: "w", widgetLines: ["plain"] });
  });

  it("gives extensions the ANSI theme and bounds string-array widgets", () => {
    const { bridge, sent } = setup();
    expect(bridge.context.theme.fg("error", "x")).toBe("\u001b[31mx\u001b[39m");
    bridge.context.setWidget("w", ["a\u001b]0;t\u0007b", ...Array.from({ length: 80 }, () => "l")]);
    const lines = (sent[0] as unknown as { widgetLines: string[] }).widgetLines;
    expect(lines).toHaveLength(50);
    expect(lines[0]).toBe("ab");
  });

  it("uses the field names of Pi's RPC extension UI protocol", () => {
    const { bridge, sent } = setup();
    bridge.context.notify("hello");
    bridge.context.setStatus("ext", undefined);
    bridge.context.setWidget("w", ["a", "b"], { placement: "belowEditor" });
    bridge.context.setTitle("pap");
    bridge.context.setEditorText("draft");
    bridge.context.pasteToEditor("pasted");
    expect(sent).toEqual([
      { type: "extension_ui_request", id: "u1", method: "notify", message: "hello", notifyType: "info" },
      {
        type: "extension_ui_request",
        id: "u2",
        method: "setStatus",
        statusKey: "ext",
        statusText: undefined,
      },
      {
        type: "extension_ui_request",
        id: "u3",
        method: "setWidget",
        widgetKey: "w",
        widgetLines: ["a", "b"],
        widgetPlacement: "belowEditor",
      },
      { type: "extension_ui_request", id: "u4", method: "setTitle", title: "pap" },
      { type: "extension_ui_request", id: "u5", method: "set_editor_text", text: "draft" },
      { type: "extension_ui_request", id: "u6", method: "set_editor_text", text: "pasted" },
    ]);
  });

  it("tells the daemon about a dialog's timeout and clears the timer once it is answered", async () => {
    const { bridge, sent, timers, cleared } = setup();
    const answer = bridge.context.confirm("t", "m", { timeout: 5000 });
    expect(sent[0]).toMatchObject({ method: "confirm", timeout: 5000 });
    bridge.resolve({ type: "extension_ui_response", id: "u1", confirmed: true });
    expect(await answer).toBe(true);
    expect(cleared).toEqual([1]);
    timers[0]?.();
    expect(sent.map((r) => r.type)).toEqual(["extension_ui_request"]);
  });

  it("resolves a dialog that was aborted before it opened without sending anything", async () => {
    const { bridge, sent } = setup();
    const controller = new AbortController();
    controller.abort();
    expect(await bridge.context.confirm("t", "m", { signal: controller.signal })).toBe(false);
    expect(sent).toEqual([]);
  });

  it("answers each dialog once and ignores unknown or late responses", async () => {
    const { bridge } = setup();
    const answer = bridge.context.confirm("t", "m");
    bridge.resolve({ type: "extension_ui_response", id: "nope", confirmed: true });
    expect(bridge.pendingCount()).toBe(1);
    bridge.resolve({ type: "extension_ui_response", id: "u1", confirmed: false });
    bridge.resolve({ type: "extension_ui_response", id: "u1", confirmed: true });
    expect(await answer).toBe(false);
  });
});

describe("extension UI bridge: answers that are not what the dialog asked for", () => {
  it("never reads anything but a literal true as approval", async () => {
    for (const fields of [{ confirmed: "true" }, { confirmed: 1 }, { value: "yes" }, {}]) {
      const { bridge } = setup();
      const answer = bridge.context.confirm("t", "m");
      bridge.resolve(respond({ id: "u1", ...fields }));
      expect(await answer).toBe(false);
    }
  });

  it("treats a malformed response as a closed dialog and tells the daemon", async () => {
    const { bridge, sent } = setup();
    const answer = bridge.context.confirm("t", "m");
    bridge.resolve(respond({ id: "u1", confirmed: "yes", cancelled: false }));
    expect(await answer).toBe(false);
    expect(sent.at(-1)).toEqual({ type: "extension_ui_closed", id: "u1" });
    expect(bridge.pendingCount()).toBe(0);
  });

  it("ignores a malformed response without an id", () => {
    const { bridge } = setup();
    void bridge.context.confirm("t", "m");
    bridge.resolve({ confirmed: true } as never);
    bridge.resolve(null as never);
    expect(bridge.pendingCount()).toBe(1);
  });

  it("accepts a select answer only when it is one of the offered options", async () => {
    const { bridge } = setup();
    const offered = bridge.context.select("Pick", ["a", "b"]);
    bridge.resolve({ type: "extension_ui_response", id: "u1", value: "b" });
    expect(await offered).toBe("b");
    const invented = bridge.context.select("Pick", ["a", "b"]);
    bridge.resolve({ type: "extension_ui_response", id: "u2", value: "c" });
    expect(await invented).toBeUndefined();
  });

  it("returns the text of an input or editor answer", async () => {
    const { bridge } = setup();
    const input = bridge.context.input("Name?");
    bridge.resolve({ type: "extension_ui_response", id: "u1", value: "pap" });
    const editor = bridge.context.editor("Edit", "old");
    bridge.resolve({ type: "extension_ui_response", id: "u2", value: "new" });
    expect([await input, await editor]).toEqual(["pap", "new"]);
  });
});

describe("extension UI bridge: a daemon link that fails", () => {
  it("resolves the fallback when the request cannot be sent, and leaves nothing pending", async () => {
    const { bridge, timers, cleared } = setup({
      failSend: (record) => record.type === "extension_ui_request",
    });
    expect(await bridge.context.confirm("t", "m", { timeout: 1000 })).toBe(false);
    expect(bridge.pendingCount()).toBe(0);
    expect(cleared).toEqual([1]);
    timers[0]?.();
  });

  it("does not throw into an extension that decorates the UI when the link is gone", () => {
    const { bridge } = setup({ failSend: () => true });
    expect(() => {
      bridge.context.notify("hello");
      bridge.context.setStatus("ext", "busy");
      bridge.context.setTitle("pap");
    }).not.toThrow();
  });

  it("still resolves a dialog when the closed notice cannot be sent", async () => {
    const { bridge } = setup({ failSend: (record) => record.type === "extension_ui_closed" });
    const answer = bridge.context.confirm("t", "m");
    bridge.cancelAll();
    expect(await answer).toBe(false);
    expect(bridge.pendingCount()).toBe(0);
  });

  it("resolves a dialog at once when its request could not be sent", async () => {
    const bridge = createUiBridge(() => false, { newId: () => "d1" });
    expect(await bridge.context.confirm("Run?", "ls")).toBe(false);
    expect(await bridge.context.select("Pick", ["a"])).toBeUndefined();
    expect(bridge.pendingCount()).toBe(0);
  });
});
