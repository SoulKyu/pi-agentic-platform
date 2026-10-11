import { PapError, UI_LIMITS } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { startLiveSession } from "./live-session.ts";
import { captureLogger } from "./testing/helpers.ts";
import { createLiveBed } from "./testing/live-bed.ts";

const setup = createLiveBed(startLiveSession);

const request = (method: string, fields: Record<string, unknown> = {}) => ({
  type: "extension_ui_request" as const,
  id: "x",
  method,
  ...fields,
});
const setStatus = (text: string, key = "git") => request("setStatus", { statusKey: key, statusText: text });
const render = (id: string, lines: string[]) => ({ type: "custom_render" as const, id, lines });

describe("decorations in the live session", () => {
  it("publishes a status bar event, and no pi event for it", async () => {
    const { worker, clock, published, live } = setup();
    worker.emit(setStatus("Build"));
    await clock.advance(0);
    expect(published.filter((event) => event.kind === "status_bar")).toEqual([
      { kind: "status_bar", key: "git", text: "Build" },
    ]);
    expect(published.filter((event) => event.kind === "pi")).toEqual([]);
    expect(live.statuses()).toEqual([{ key: "git", text: "Build" }]);
  });

  it("folds 100 status updates of one key within 10 ms into the first and the latest", async () => {
    const { worker, clock, published } = setup();
    for (let i = 0; i < 100; i++) {
      worker.emit(setStatus(`s${i}`));
      await clock.advance(0.1);
    }
    expect(published.filter((event) => event.kind === "status_bar")).toEqual([
      { kind: "status_bar", key: "git", text: "s0" },
    ]);
    await clock.advance(50);
    expect(published.filter((event) => event.kind === "status_bar")).toEqual([
      { kind: "status_bar", key: "git", text: "s0" },
      { kind: "status_bar", key: "git", text: "s99" },
    ]);
  });

  it("publishes widgets, titles and editor text, the last one at once", async () => {
    const { worker, clock, published, live } = setup();
    worker.emit(request("setWidget", { widgetKey: "todo", widgetLines: ["- a"] }));
    worker.emit(request("setTitle", { title: "pi - repo" }));
    worker.emit(request("set_editor_text", { text: "prefill" }));
    await clock.advance(0);
    expect(published.map((event) => event.kind)).toEqual(["status", "widget", "title", "editor_text"]);
    expect(live.widgets()).toEqual([{ key: "todo", lines: ["- a"], placement: "aboveEditor" }]);
    expect(live.title()).toBe("pi - repo");
  });

  it("stamps a notify as the extension's own and keeps it in the ring with its source", async () => {
    const { worker, clock, published, live } = setup();
    worker.emit(request("notify", { message: "saved", notifyType: "warning" }));
    await clock.advance(0);
    expect(published.filter((event) => event.kind === "notice")).toEqual([
      { kind: "notice", level: "warning", text: "saved", source: "extension" },
    ]);
    expect(live.notices()).toEqual([{ level: "warning", text: "saved", source: "extension" }]);
  });

  it("limits extension notices to 10 per window and still keeps pap's own: the ring holds the last 20", async () => {
    const { worker, clock, published, live } = setup();
    for (let i = 0; i < 40; i++) worker.emit(request("notify", { message: `n${i}` }));
    await clock.advance(0);
    expect(published.filter((event) => event.kind === "notice")).toHaveLength(10);
    await clock.advance(10_000);
    const texts = published.flatMap((event) => (event.kind === "notice" ? [event.text] : []));
    expect(texts.at(-1)).toBe("30 more notices from extensions were not shown.");
    expect(live.notices().map((notice) => notice.text)).toEqual([
      ...Array.from({ length: 10 }, (_, i) => `n${i}`),
      "30 more notices from extensions were not shown.",
    ]);
    for (let i = 0; i < UI_LIMITS.notices + 3; i++) {
      worker.emit({ type: "extension_error", extensionPath: "/x.js", event: "tool_call", error: "boom" });
      await clock.advance(10_000);
    }
    expect(live.notices()).toHaveLength(UI_LIMITS.notices);
  });

  it("sends an extension error through the same limiter, in pap's own words and without a source", async () => {
    const { worker, clock, published, live } = setup();
    worker.emit({ type: "extension_error", extensionPath: "/x.js", event: "session_start", error: "boom" });
    await clock.advance(0);
    expect(published.filter((event) => event.kind === "notice")).toEqual([
      { kind: "notice", level: "error", text: "An extension failed during session_start." },
    ]);
    expect(live.notices()).toEqual([{ level: "error", text: "An extension failed during session_start." }]);
  });

  it("counts extension errors and extension notices in the same window of 10", async () => {
    const { worker, clock, published } = setup();
    for (let i = 0; i < 12; i++) {
      worker.emit({ type: "extension_error", extensionPath: "/x.js", event: "tool_call", error: "boom" });
    }
    for (let i = 0; i < 5; i++) worker.emit(request("notify", { message: `n${i}` }));
    await clock.advance(10_000);
    const texts = published.flatMap((event) => (event.kind === "notice" ? [event.text] : []));
    expect(texts).toHaveLength(11);
    expect(texts.at(-1)).toBe("7 more notices from extensions were not shown.");
  });

  it("logs malformed decorations at most once in 10 s, with the count", async () => {
    const { logger, lines } = captureLogger();
    const { worker, clock } = setup({ logger });
    for (let i = 0; i < 50; i++) worker.emit(request("setStatus", { statusKey: 5 }));
    await clock.advance(0);
    expect(lines.filter((line) => line.msg === "decoration_refused")).toHaveLength(1);
    await clock.advance(10_000);
    worker.emit(request("setStatus", { statusKey: 5 }));
    await clock.advance(0);
    const logged = lines.filter((line) => line.msg === "decoration_refused");
    expect(logged).toHaveLength(2);
    expect(logged[1]).toMatchObject({ suppressed: 49 });
  });

  it("clears decorations and panels at the worker's exit and leaves no timer", async () => {
    const { worker, clock, published, live } = setup();
    worker.emit(setStatus("a"));
    worker.emit(setStatus("b"));
    worker.emit(request("notify", { message: "1" }));
    for (let i = 0; i < 11; i++) worker.emit(request("notify", { message: `m${i}` }));
    worker.emit(render("p1", ["a"]));
    worker.emit(render("p1", ["b"]));
    await clock.advance(0);
    expect(clock.pending()).toBe(3);
    worker.crash({ code: null, signal: "SIGKILL", cause: "killed" });
    await clock.advance(0);
    expect(live.statuses()).toEqual([]);
    expect(live.panels()).toEqual([]);
    expect(clock.pending()).toBe(0);
    const kinds = published.map((event) => event.kind);
    expect(kinds.indexOf("panel_closed")).toBeGreaterThan(-1);
    expect(kinds.indexOf("panel_closed")).toBeLessThan(kinds.lastIndexOf("status"));
    await clock.advance(60_000);
    expect(published.filter((event) => event.kind === "status_bar")).toHaveLength(1);
  });
});

describe("panels in the live session", () => {
  it("publishes a panel, replaces it, and closes it", async () => {
    const { worker, clock, published, live } = setup();
    worker.emit(render("p1", ["a"]));
    worker.emit({ type: "custom_close", id: "p1" });
    await clock.advance(0);
    expect(published.filter((event) => event.kind.startsWith("panel"))).toEqual([
      { kind: "panel", panel: { id: "p1", lines: ["a"] } },
      { kind: "panel_closed", id: "p1" },
    ]);
    expect(live.panels()).toEqual([]);
  });

  it("cancels a fifth panel, tells the person once", async () => {
    const { worker, clock, published } = setup();
    for (const id of ["p1", "p2", "p3", "p4", "p5", "p6"]) worker.emit(render(id, ["x"]));
    await clock.advance(0);
    expect(worker.sent.filter((record) => record.type === "custom_cancel")).toEqual([
      { type: "custom_cancel", id: "p5" },
      { type: "custom_cancel", id: "p6" },
    ]);
    expect(published.filter((event) => event.kind === "notice")).toHaveLength(1);
  });

  it("ignores a close and a late render of a panel it never opened, without a log line", async () => {
    const { logger, lines } = captureLogger();
    const { worker, clock, published, live } = setup({ logger });
    for (let i = 0; i < 100; i++) worker.emit({ type: "custom_close", id: `ghost${i}` });
    await clock.advance(0);
    expect(published.map((event) => event.kind)).toEqual(["status"]);
    expect(live.panels()).toEqual([]);
    expect(lines.filter((line) => String(line.msg).includes("panel"))).toEqual([]);
  });

  it("sends the input of an open panel to the worker, and refuses an unknown one", async () => {
    const { worker, clock, live } = setup();
    worker.emit(render("p1", ["a"]));
    await clock.advance(0);
    live.panelInput("p1", "\r");
    expect(worker.sent.at(-1)).toEqual({ type: "custom_input", id: "p1", data: "\r" });
    expect(() => live.panelInput("nope", "x")).toThrow(new PapError("not_found"));
    expect(() => live.panelInput("p1", "x".repeat(UI_LIMITS.panelInput + 1))).toThrow(
      new PapError("bad_request"),
    );
    expect(() => live.panelInput("p1", "")).toThrow(new PapError("bad_request"));
  });

  it("cancels every open panel when it is stopped", async () => {
    const { worker, clock, live } = setup();
    worker.emit(render("p1", ["a"]));
    worker.emit(render("p2", ["a"]));
    await clock.advance(0);
    await live.stop();
    const types = worker.sent.map((record) => record.type);
    expect(worker.sent.filter((record) => record.type === "custom_cancel")).toEqual([
      { type: "custom_cancel", id: "p1" },
      { type: "custom_cancel", id: "p2" },
    ]);
    expect(types.lastIndexOf("custom_cancel")).toBeLessThan(types.indexOf("shutdown"));
  });
});
