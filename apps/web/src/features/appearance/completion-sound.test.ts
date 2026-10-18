// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  playCompletion,
  resetCompletionSound,
  unlockCompletionSound,
  unlockOnFirstInteraction,
} from "./completion-sound.ts";

function fakeContext(initial: "running" | "suspended" = "running") {
  const osc = {
    frequency: { value: 0 },
    type: "",
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
  const gain = { gain: { value: 0 }, connect: vi.fn() };
  const ctx = {
    state: initial as string,
    currentTime: 5,
    destination: {},
    resume: vi.fn(() => Promise.resolve()),
    createOscillator: vi.fn(() => osc),
    createGain: vi.fn(() => gain),
  };
  return { ctx: ctx as unknown as AudioContext, raw: ctx, osc };
}
const away = { enabled: true, hidden: true, focused: true };

afterEach(() => {
  resetCompletionSound();
  vi.unstubAllGlobals();
});

describe("playCompletion", () => {
  it("plays nothing when the setting is off", () => {
    const { ctx, raw } = fakeContext();
    expect(playCompletion({ ...away, enabled: false, ctx })).toBe(false);
    expect(raw.createOscillator).not.toHaveBeenCalled();
  });

  it("plays nothing while the tab is visible and focused", () => {
    const { ctx, raw } = fakeContext();
    expect(playCompletion({ enabled: true, hidden: false, focused: true, ctx })).toBe(false);
    expect(raw.createOscillator).not.toHaveBeenCalled();
  });

  it("plays one 880 Hz tone of 120 ms when the tab is hidden", () => {
    const { ctx, osc } = fakeContext();
    expect(playCompletion({ ...away, ctx })).toBe(true);
    expect(osc.frequency.value).toBe(880);
    expect(osc.start).toHaveBeenCalledTimes(1);
    expect(osc.stop).toHaveBeenCalledTimes(1);
    expect(osc.stop.mock.calls[0]?.[0]).toBeCloseTo(5.12, 5);
  });

  it("plays when the tab is visible but not focused", () => {
    const { ctx } = fakeContext();
    expect(playCompletion({ enabled: true, hidden: false, focused: false, ctx })).toBe(true);
  });

  it("creates the context lazily, once, and gives false with no tone while it is suspended", () => {
    const made = fakeContext("suspended");
    const Ctor = vi.fn(function () {
      return made.ctx;
    });
    vi.stubGlobal("AudioContext", Ctor);
    expect(Ctor).not.toHaveBeenCalled();
    expect(playCompletion({ ...away })).toBe(false);
    expect(playCompletion({ ...away })).toBe(false);
    expect(Ctor).toHaveBeenCalledTimes(1);
    expect(made.raw.resume).toHaveBeenCalled();
    expect(made.raw.createOscillator).not.toHaveBeenCalled();
  });

  it("unlocking builds the context and resumes it when suspended; a running one is left alone", () => {
    const made = fakeContext("suspended");
    const Ctor = vi.fn(function () {
      return made.ctx;
    });
    vi.stubGlobal("AudioContext", Ctor);
    unlockCompletionSound();
    expect(Ctor).toHaveBeenCalledTimes(1);
    expect(made.raw.resume).toHaveBeenCalledTimes(1);
    made.raw.state = "running";
    unlockCompletionSound();
    expect(made.raw.resume).toHaveBeenCalledTimes(1);
    expect(playCompletion({ ...away })).toBe(true);
  });

  it("unlocking never throws when the context cannot be built", () => {
    vi.stubGlobal(
      "AudioContext",
      vi.fn(function () {
        throw new Error("blocked");
      }),
    );
    expect(() => unlockCompletionSound()).not.toThrow();
  });

  it("keeps listening until the context runs, then stops", () => {
    const made = fakeContext("suspended");
    vi.stubGlobal(
      "AudioContext",
      vi.fn(function () {
        return made.ctx;
      }),
    );
    const off = unlockOnFirstInteraction();
    document.dispatchEvent(new Event("pointerdown"));
    expect(made.raw.resume).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new Event("pointerup"));
    expect(made.raw.resume).toHaveBeenCalledTimes(2);
    made.raw.state = "running";
    document.dispatchEvent(new Event("click"));
    document.dispatchEvent(new Event("keydown"));
    document.dispatchEvent(new Event("click"));
    expect(made.raw.resume).toHaveBeenCalledTimes(2);
    off();
  });

  it("skips a second tone within the tone's length, and plays again after it", () => {
    const { ctx, raw, osc } = fakeContext();
    expect(playCompletion({ ...away, ctx })).toBe(true);
    raw.currentTime = 5.05;
    expect(playCompletion({ ...away, ctx })).toBe(false);
    raw.currentTime = 5.13;
    expect(playCompletion({ ...away, ctx })).toBe(true);
    expect(osc.start).toHaveBeenCalledTimes(2);
  });

  it("does not build a context while it has nothing to play", () => {
    const Ctor = vi.fn();
    vi.stubGlobal("AudioContext", Ctor);
    expect(playCompletion({ enabled: false, hidden: true, focused: false })).toBe(false);
    expect(playCompletion({ enabled: true, hidden: false, focused: true })).toBe(false);
    expect(Ctor).not.toHaveBeenCalled();
  });

  it("returns false and does not throw when the context cannot be built", () => {
    vi.stubGlobal(
      "AudioContext",
      vi.fn(function () {
        throw new Error("blocked");
      }),
    );
    expect(playCompletion({ ...away })).toBe(false);
  });

  it("returns false when the engine is missing or the tone fails", () => {
    expect(playCompletion({ ...away })).toBe(false);
    const { raw } = fakeContext();
    raw.createOscillator.mockImplementation(() => {
      throw new Error("closed");
    });
    expect(playCompletion({ ...away, ctx: raw as unknown as AudioContext })).toBe(false);
  });
});
