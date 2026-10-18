import { afterEach, describe, expect, it, vi } from "vitest";
import { playCompletion, resetCompletionSound } from "./completion-sound.ts";

function fakeContext(state: "running" | "suspended" = "running") {
  const osc = {
    frequency: { value: 0 },
    type: "",
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
  const gain = { gain: { value: 0 }, connect: vi.fn() };
  const ctx = {
    state,
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

  it("creates the context lazily, once, and resumes it when suspended", () => {
    const made = fakeContext("suspended");
    const Ctor = vi.fn(function () {
      return made.ctx;
    });
    vi.stubGlobal("AudioContext", Ctor);
    expect(Ctor).not.toHaveBeenCalled();
    expect(playCompletion({ ...away })).toBe(true);
    expect(playCompletion({ ...away })).toBe(true);
    expect(Ctor).toHaveBeenCalledTimes(1);
    expect(made.raw.resume).toHaveBeenCalled();
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
