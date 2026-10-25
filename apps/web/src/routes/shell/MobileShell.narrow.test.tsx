// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance } from "../../features/appearance/index.ts";
import { startKeybindings } from "../../features/commands/index.ts";
import { EMPTY_WORKSPACE, useWorkspaceStore } from "../../features/workspace/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { renderShell } from "../../testing/shell-bed.tsx";
import { useShellStore } from "../../stores/shell-store.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("./HomePane.tsx", async () => {
  const { createElement } = await import("react");
  return { HomePane: () => createElement("p", { "data-stub": "home" }) };
});

let started: Array<{ stop(): void }> = [];
beforeEach(() => {
  started = [startAppearance(window), startKeybindings()];
  useShellStore.getState().reset();
  const bed = fakeRuntime("idle");
  bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
  current.runtime = bed.runtime;
  localStorage.clear();
  useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
});
afterEach(() => {
  started.forEach((one) => one.stop());
  started = [];
});

describe("the phone header under 400 px", () => {
  it("hides its title and the chip can shrink; Open items uses Layers", async () => {
    const page = await renderShell("/", { phone: true });
    const header = page.container.querySelector("header") as HTMLElement;
    const title = header.querySelector(":scope > span.flex-1") as HTMLElement;
    expect(title.className).toContain("max-xs:hidden");
    const chip = header.querySelector("[data-project-chip]") as HTMLElement;
    expect(chip.className).toContain("min-w-0");
    expect(chip.className).not.toContain("shrink-0");
    const openItems = header.querySelector('button[aria-label="Open items"]') as HTMLElement;
    expect(openItems.querySelector("svg")?.getAttribute("class")).toContain("lucide-layers");
    await page.unmount();
  });
});
