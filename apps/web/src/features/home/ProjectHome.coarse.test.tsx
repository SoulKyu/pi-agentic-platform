// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCurrentProject } from "../../stores/current-project.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import type { Runtime } from "../../runtime/index.ts";
import { act } from "react";
import { composer, resetHome, showHome } from "../../testing/home-bed.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

vi.mock("./HomeBody.tsx", () => ({ default: () => null }));

const pointer = (coarse: boolean) =>
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(pointer: coarse)" ? coarse : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));

beforeEach(() => {
  current.runtime = fakeRuntime("open").runtime;
  resetHome();
});
afterEach(() => vi.unstubAllGlobals());

describe("ProjectHome: the keyboard on a phone (M12 task 19, board 12)", () => {
  it("does not take the focus on mount under a coarse pointer, so the keyboard stays down", async () => {
    pointer(true);
    const { page } = await showHome();
    expect(composer()).not.toBeNull();
    expect(document.activeElement).not.toBe(composer());
    await page.unmount();
  });

  it("still takes the focus on mount under a fine pointer", async () => {
    pointer(false);
    const { page } = await showHome();
    expect(document.activeElement).toBe(composer());
    await page.unmount();
  });

  it("takes the focus when 'New session here' asks for it, on a phone too (a gesture asked)", async () => {
    pointer(true);
    const { page } = await showHome();
    await act(async () => useCurrentProject.setState({ startedHere: 1 }));
    expect(document.activeElement).toBe(composer());
    await page.unmount();
  });
});
