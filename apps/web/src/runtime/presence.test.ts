import { describe, expect, it } from "vitest";
import { manualTimers } from "../testing/push-env.ts";
import { startPresence } from "./presence.ts";
import { fakeConnection } from "./testing.ts";

class Doc extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";
  focus = true;
  hasFocus = () => this.focus;
}
class Win extends EventTarget {}

function bed(state: "open" | "idle" | "signed-out" | "waiting" = "open") {
  const conn = fakeConnection(state);
  const doc = new Doc();
  const win = new Win();
  const clock = manualTimers();
  const time = { now: 1_000_000 };
  const sent: boolean[] = [];
  const rpc = {
    call: (method: string, params: { focused: boolean }) => {
      if (method !== "push.presence") throw new Error(method);
      sent.push(params.focused);
      return Promise.resolve({ ok: true });
    },
  };
  const stop = startPresence({
    rpc: rpc as never,
    connection: conn.connection,
    timers: clock.timers,
    doc,
    win,
    now: () => time.now,
  });
  return { conn, doc, win, clock, time, sent, stop };
}

describe("presence (M12R11)", () => {
  it("sends on start while the connection is open", () => {
    expect(bed().sent).toEqual([true]);
  });

  it("sends on focus, blur and visibilitychange", () => {
    const page = bed();
    page.doc.focus = false;
    page.win.dispatchEvent(new Event("blur"));
    page.doc.focus = true;
    page.win.dispatchEvent(new Event("focus"));
    page.doc.visibilityState = "hidden";
    page.doc.dispatchEvent(new Event("visibilitychange"));
    expect(page.sent).toEqual([true, false, true, false]);
  });

  it("repeats every 20 s while open", () => {
    const page = bed();
    expect(page.clock.pending()).toEqual([20_000]);
    page.clock.fireNext();
    page.clock.fireNext();
    expect(page.sent).toEqual([true, true, true]);
    expect(page.clock.pending()).toEqual([20_000]);
  });

  it("starts sending when the connection opens and stops its timer when it is not open", () => {
    const page = bed("idle");
    expect(page.sent).toEqual([]);
    expect(page.clock.pending()).toEqual([]);
    page.conn.setState("open");
    expect(page.sent).toEqual([true]);
    expect(page.clock.pending()).toEqual([20_000]);
    page.conn.setState("waiting");
    expect(page.clock.pending()).toEqual([]);
    page.win.dispatchEvent(new Event("focus"));
    expect(page.sent).toEqual([true]);
  });

  it("sends nothing while signed out, whatever happens on the page", () => {
    const page = bed("signed-out");
    page.win.dispatchEvent(new Event("focus"));
    page.win.dispatchEvent(new Event("pagehide"));
    page.doc.dispatchEvent(new Event("visibilitychange"));
    expect(page.sent).toEqual([]);
    expect(page.clock.pending()).toEqual([]);
  });

  it("pagehide sends focused false best effort", () => {
    const page = bed();
    page.win.dispatchEvent(new Event("pagehide"));
    expect(page.sent).toEqual([true, false]);
  });

  it("presence.idle-is-not-looking: a focused visible tab with no input for 2 minutes reports false", () => {
    const page = bed();
    page.time.now += 119_999;
    page.clock.fireNext();
    page.time.now += 1;
    page.clock.fireNext();
    expect(page.sent).toEqual([true, true, false]);
  });

  it("input restarts the 2 minutes and reports looking again at once after an idle report", () => {
    const page = bed();
    page.time.now += 130_000;
    page.clock.fireNext();
    expect(page.sent).toEqual([true, false]);
    page.win.dispatchEvent(new Event("keydown"));
    expect(page.sent).toEqual([true, false, true]);
    page.win.dispatchEvent(new Event("pointerdown"));
    page.win.dispatchEvent(new Event("wheel"));
    expect(page.sent).toEqual([true, false, true]);
    page.time.now += 119_000;
    page.clock.fireNext();
    expect(page.sent).toEqual([true, false, true, true]);
  });

  it("counts pointerdown, keydown, touchstart and wheel as input", () => {
    for (const type of ["pointerdown", "keydown", "touchstart", "wheel"]) {
      const page = bed();
      page.time.now += 130_000;
      page.clock.fireNext();
      page.win.dispatchEvent(new Event(type));
      expect(page.sent, type).toEqual([true, false, true]);
    }
  });

  it("stop() removes every listener and timer (leak check)", () => {
    const page = bed();
    page.stop();
    expect(page.clock.pending()).toEqual([]);
    const before = page.sent.length;
    for (const type of ["focus", "blur", "pagehide", "keydown", "pointerdown", "touchstart", "wheel"]) {
      page.win.dispatchEvent(new Event(type));
    }
    page.doc.dispatchEvent(new Event("visibilitychange"));
    page.conn.setState("open");
    expect(page.sent.length).toBe(before);
    expect(page.clock.pending()).toEqual([]);
  });

  it("a rejected presence call is swallowed", async () => {
    const conn = fakeConnection("open");
    const clock = manualTimers();
    const rpc = { call: () => Promise.reject(new Error("capacity")) };
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", listener);
    startPresence({
      rpc: rpc as never,
      connection: conn.connection,
      timers: clock.timers,
      doc: new Doc(),
      win: new Win(),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.off("unhandledRejection", listener);
    expect(unhandled).toEqual([]);
  });
});
