// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAppearanceStore } from "../appearance/appearance-store.ts";
import { DEFAULT_DEVICE } from "../appearance/model.ts";
import { resetCompletionSound } from "../appearance/completion-sound.ts";
import type { Runtime } from "../../runtime/index.ts";
import { screenBed } from "../../testing/screen-bed.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return {
    Link: (props: { to: string; children: unknown }) =>
      createElement("a", { href: props.to }, props.children as never),
    useNavigate: () => vi.fn(),
  };
});

const screen = screenBed(current);
const approval = {
  id: "a1",
  method: "approval",
  title: "Run a command?",
  message: "1 line\nbash: ls",
  category: "exec",
  answers: ["deny", "once"],
};
const live = (container: HTMLElement) => container.querySelector("[data-announcer]");

describe("polite live regions (DESIGN §12)", () => {
  it("is one polite status region that starts empty", async () => {
    const container = await screen.show({ status: "idle" });
    expect(live(container)?.getAttribute("role")).toBe("status");
    expect(live(container)?.getAttribute("aria-live")).toBe("polite");
    expect(live(container)?.textContent).toBe("");
  });

  it("announces the end of a run, and again at the end of the next one", async () => {
    const container = await screen.show({ status: "idle" });
    await screen.emit({ kind: "status", status: "running" });
    expect(live(container)?.textContent).toBe("");
    await screen.emit({ kind: "status", status: "idle" });
    expect(live(container)?.textContent).toBe("The agent has finished.");
    await screen.emit({ kind: "status", status: "running" });
    expect(live(container)?.textContent).toBe("");
    await screen.emit({ kind: "status", status: "idle" });
    expect(live(container)?.textContent).toBe("The agent has finished.");
  });

  it("does not say the agent finished when the session went cold", async () => {
    const container = await screen.show({ status: "running" });
    await screen.emit({ kind: "status", status: "cold" });
    expect(live(container)?.textContent).toBe("");
  });

  it("announces a new approval", async () => {
    const container = await screen.show({ status: "running" });
    await screen.emit({ kind: "dialog_open", dialog: approval });
    expect(live(container)?.textContent).toBe("The agent is waiting for your approval.");
  });

  it("does not announce an extension's dialog as an approval", async () => {
    const container = await screen.show({ status: "running" });
    await screen.emit({ kind: "dialog_open", dialog: { id: "i1", method: "input", title: "Name?" } });
    expect(live(container)?.textContent).toBe("");
  });
});

describe("completion sound on a settled run", () => {
  const tones = vi.fn();
  const install = (enabled: boolean, hidden: boolean) => {
    vi.stubGlobal(
      "AudioContext",
      vi.fn(function () {
        return {
          state: "running",
          currentTime: 0,
          destination: {},
          resume: () => Promise.resolve(),
          createGain: () => ({ gain: { value: 0 }, connect: vi.fn() }),
          createOscillator: () => {
            tones();
            return { frequency: { value: 0 }, connect: vi.fn(), start: vi.fn(), stop: vi.fn() };
          },
        };
      }),
    );
    vi.spyOn(document, "hidden", "get").mockReturnValue(hidden);
    useAppearanceStore.setState({ device: { ...DEFAULT_DEVICE, completionSound: enabled } });
  };
  afterEach(() => {
    tones.mockClear();
    resetCompletionSound();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    useAppearanceStore.setState({ device: DEFAULT_DEVICE });
  });

  it("plays one tone when the run ends while the tab is hidden", async () => {
    install(true, true);
    await screen.show({ status: "running" });
    await screen.emit({ kind: "status", status: "idle" });
    expect(tones).toHaveBeenCalledTimes(1);
  });

  it("stays silent when off, when visible and focused, and when the session goes cold", async () => {
    install(false, true);
    await screen.show({ status: "running" });
    await screen.emit({ kind: "status", status: "idle" });
    install(true, false);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    await screen.emit({ kind: "status", status: "running" });
    await screen.emit({ kind: "status", status: "idle" });
    install(true, true);
    await screen.emit({ kind: "status", status: "running" });
    await screen.emit({ kind: "status", status: "cold" });
    expect(tones).not.toHaveBeenCalled();
  });

  it("stays silent when a child agent of the session settles", async () => {
    install(true, true);
    await screen.show({ status: "running" });
    await screen.emit({ kind: "status", status: "running", children: [{ id: "c1", status: "idle" }] });
    expect(tones).not.toHaveBeenCalled();
  });

  it("with the setting on at mount, listens for gestures until the context runs", async () => {
    const ctx = { state: "suspended", resume: vi.fn(() => Promise.resolve()) };
    vi.stubGlobal(
      "AudioContext",
      vi.fn(function () {
        return ctx;
      }),
    );
    useAppearanceStore.setState({ device: { ...DEFAULT_DEVICE, completionSound: true } });
    await screen.show({ status: "idle" });
    document.dispatchEvent(new Event("pointerdown"));
    expect(ctx.resume).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new Event("click"));
    expect(ctx.resume).toHaveBeenCalledTimes(2);
    ctx.state = "running";
    document.dispatchEvent(new Event("click"));
    document.dispatchEvent(new Event("click"));
    expect(ctx.resume).toHaveBeenCalledTimes(2);
  });
});
