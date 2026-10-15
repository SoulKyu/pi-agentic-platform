// @vitest-environment happy-dom
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { Runtime } from "../../runtime/index.ts";
import { useUsageStore } from "../../stores/usage-store.ts";
import { settle } from "../../testing/dom.ts";
import { screenBed } from "../../testing/screen-bed.tsx";
import { limitView, usageSnapshot } from "../../testing/usage-bed.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return {
    Link: (props: { to: string; children: ReactNode }) =>
      createElement("a", { href: props.to }, props.children),
    useNavigate: () => () => Promise.resolve(),
  };
});

const screen = screenBed(current);
beforeEach(() => useUsageStore.getState().reset());

const chips = (container: HTMLElement) =>
  [...container.querySelectorAll("header [data-slot='chip']")].map((chip) => [
    chip.getAttribute("data-tone"),
    chip.textContent,
  ]);

describe("SessionScreen and the quota limit (M10R108)", () => {
  it("reads a cold session as settled, never limited", async () => {
    const container = await screen.show({ status: "cold" });
    expect(chips(container)).toEqual([["ok", "Stopped"]]);
  });

  it("keeps the usage stream open while it shows and mounts the limit chip beside the run status", async () => {
    const container = await screen.show({ status: "idle" });
    expect(screen.bed.called("subscribe.usage")).toHaveLength(1);
    await act(async () => {
      useUsageStore.getState().apply(usageSnapshot([limitView({ resetAt: null })]));
    });
    await settle();
    expect(chips(container)).toEqual([
      ["ok", "Ready"],
      ["mut", "Limit reached"],
    ]);
    expect(container.querySelector("header [data-limit-menu]")).not.toBeNull();
  });
});
