// @vitest-environment happy-dom
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance } from "../../features/appearance/index.ts";
import { startKeybindings } from "../../features/commands/index.ts";
import { EMPTY_WORKSPACE, useWorkspaceStore } from "../../features/workspace/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { button, click, settle } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { renderShell } from "../../testing/shell-bed.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
const chunk = vi.hoisted(() => {
  let release: () => void = () => {};
  const loaded = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { loaded, release };
});
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("./HomePane.tsx", () => ({ HomePane: () => createElement("p", { "data-stub": "home" }) }));
// The test bed's warm-up would wait for the held-back chunk below.
vi.mock("../../testing/chunks.ts", () => ({ loadShellChunks: async () => {} }));
// The Agents tab's chunk: held back until the test lets it through.
vi.mock("./AgentsSection.tsx", async () => {
  await chunk.loaded;
  return { AgentsSection: () => createElement("p", { "data-stub": "agents" }) };
});

let started: Array<{ stop(): void }> = [];
beforeEach(() => {
  started = [startAppearance(window), startKeybindings()];
  const bed = fakeRuntime("open");
  bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
  current.runtime = bed.runtime;
  localStorage.clear();
  useShellStore.getState().reset();
  useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
});
afterEach(() => {
  started.forEach((one) => one.stop());
  started = [];
});

describe("the phone Agents tab while its chunk loads", () => {
  it("shows a loading line instead of an empty page, then the tab", async () => {
    const page = await renderShell("/", { phone: true });
    const nav = page.container.querySelector("nav") as HTMLElement;
    await click(button(nav, "Agents"));
    await settle();
    const main = page.container.querySelector("main") as HTMLElement;
    expect(main.textContent).toBe("Loading…");
    expect(main.querySelector('[data-stub="agents"]')).toBeNull();
    chunk.release();
    await vi.waitFor(async () => {
      await settle();
      expect(main.querySelector('[data-stub="agents"]')).not.toBeNull();
    });
    expect(main.textContent).not.toContain("Loading…");
    await page.unmount();
  });
});
