// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PREVIEW_SANDBOX } from "@pap/ui";
import type { Runtime } from "../../runtime/index.ts";
import { RpcError } from "../../runtime/rpc.ts";
import { usePreviewsStore } from "../../stores/previews-store.ts";
import { button, mount } from "../../testing/dom.ts";
import { AGENT_BOX, keepFramesUnloaded, previewView, PROJECT_BOX } from "../../testing/previews-fixtures.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import PreviewWindow from "./PreviewWindow.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed: ReturnType<typeof fakeRuntime>;
const CAPABILITY = "https://p.example:7778/p/SECRETTOKEN/";
const settle = () => act(async () => {});
const frame = (container: HTMLElement) => container.querySelector("iframe") as HTMLIFrameElement | null;
const snapshot = (...services: ReturnType<typeof previewView>[]) =>
  act(() => bed.emitTo("subscribe.previews", { type: "snapshot", services }));

beforeEach(() => {
  keepFramesUnloaded();
  bed = fakeRuntime();
  bed.handlers["previews.open"] = () => ({ url: CAPABILITY, lease: "1".repeat(32), leaseMs: 300_000 });
  bed.handlers["previews.renew"] = () => ({ until: 1 });
  bed.handlers["previews.close"] = () => ({});
  current.runtime = bed.runtime;
  usePreviewsStore.getState().reset();
});
afterEach(() => vi.useRealTimers());

const show = async (box = PROJECT_BOX) => {
  const page = await mount(<PreviewWindow box={box} name="web" />);
  await settle();
  await snapshot(previewView({ box }));
  await settle();
  return page;
};

describe("PreviewWindow", () => {
  it("renders the label outside a frame with PREVIEW_SANDBOX", async () => {
    const page = await show();
    const iframe = frame(page.container);
    expect(page.container.querySelector("[data-preview-window]")).not.toBeNull();
    expect(iframe?.getAttribute("src")).toBe(CAPABILITY);
    expect(iframe?.getAttribute("sandbox")).toBe(PREVIEW_SANDBOX);
    const label = page.container.querySelector("figcaption");
    expect(label?.textContent).toBe("UNTRUSTED · preview web");
    expect(iframe?.contains(label ?? null)).toBe(false);
  });

  it("subscribes to the previews feed on mount and empties the store at unmount", async () => {
    const page = await show();
    expect(bed.called("subscribe.previews")).toHaveLength(1);
    expect(usePreviewsStore.getState().services.size).toBe(1);
    await page.unmount();
    expect(usePreviewsStore.getState().services.size).toBe(0);
    expect(usePreviewsStore.getState().ready).toBe(false);
  });

  it("mints on load, renews every 60 s and closes at pagehide", async () => {
    vi.useFakeTimers();
    const page = await mount(<PreviewWindow box={PROJECT_BOX} name="web" />);
    await settle();
    await snapshot(previewView());
    expect(bed.called("previews.open")).toHaveLength(1);
    expect(bed.called("previews.renew")).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(bed.called("previews.renew")).toHaveLength(1);
    expect(bed.called("previews.renew")[0]?.params).toEqual({ lease: "1".repeat(32) });
    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(bed.called("previews.close")[0]?.params).toEqual({ lease: "1".repeat(32) });
    await page.unmount();
    expect(bed.called("previews.close")).toHaveLength(1);
  });

  it("the capability URL is never in location or history", async () => {
    const before = window.history.length;
    const page = await show();
    expect(frame(page.container)?.getAttribute("src")).toContain("SECRETTOKEN");
    expect(window.location.href).not.toContain("SECRETTOKEN");
    expect(window.history.length).toBe(before);
    expect(JSON.stringify(window.history.state)).not.toContain("SECRETTOKEN");
  });

  it("PreviewWindow shows gone when the stream removes the service", async () => {
    const page = await show();
    act(() => bed.emitTo("subscribe.previews", { type: "removed", box: PROJECT_BOX, name: "web" }));
    expect(page.container.textContent).toContain("This preview is not running.");
    expect(frame(page.container)).toBeNull();
    expect(bed.called("previews.close")).toHaveLength(1);
  });

  it("a restart under a new id loads nothing new and offers OPEN PREVIEW", async () => {
    const page = await show();
    act(() =>
      bed.emitTo("subscribe.previews", {
        type: "service",
        service: previewView({ id: "c".repeat(32), startedAt: 9 }),
      }),
    );
    expect(page.container.textContent).toContain("This preview restarted.");
    expect(frame(page.container)).toBeNull();
    expect(bed.called("previews.open")).toHaveLength(1);
    await act(async () => button(page.container, "Open preview").click());
    expect(bed.called("previews.open")).toHaveLength(2);
    expect(frame(page.container)?.getAttribute("src")).toBe(CAPABILITY);
  });

  it.each([
    [PROJECT_BOX, "The box is stopped."],
    [AGENT_BOX, "The agent's VM is stopped."],
  ])("a stopped box or VM is said in words, with a way to try again (%o)", async (box, words) => {
    bed.handlers["previews.open"] = () => {
      throw new RpcError("box_stopped");
    };
    const page = await show(box);
    expect(page.container.textContent).toContain(words);
    expect(frame(page.container)).toBeNull();
    expect(button(page.container, "Open preview")).toBeTruthy();
  });

  it("another person's box is refused by the daemon and nothing is framed", async () => {
    bed.handlers["previews.open"] = () => {
      throw new RpcError("forbidden");
    };
    const page = await show();
    expect(frame(page.container)).toBeNull();
    expect(page.container.querySelector('[role="alert"]')).not.toBeNull();
  });
});
