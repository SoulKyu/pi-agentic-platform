// @vitest-environment happy-dom
import { act } from "react";
import { useCurrentProject } from "../../stores/current-project.ts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { alerts, button, click } from "../../testing/dom.ts";
import { chip, resetHome, showHome } from "../../testing/home-bed.tsx";
import { fakeHomeActions } from "../../testing/home-actions.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
// The facts chunk registers the home catalog when it loads: stubbed, so only the launch chunk can bring those words.
vi.mock("./ProjectFacts.tsx", () => ({ default: () => null }));

beforeEach(() => {
  current.runtime = fakeRuntime("open").runtime;
  resetHome();
});

describe("ProjectHome: a launch that ends badly", () => {
  // The launch chunk is not warmed on purpose: the composer renders before it has registered its words.
  it(
    "says the Lane dialog could not open in words, not in a raw key, when no host answers (stale translator)",
    { timeout: 30_000 },
    async () => {
      const actions = fakeHomeActions();
      actions.newLane.mockReturnValue(false);
      const { page } = await showHome(actions);
      await click(chip("Lane"));
      await click(button(page.container, "Launch a lane"));
      await vi.waitFor(() => expect(alerts(page.container)).not.toEqual([]), { timeout: 20_000 });
      expect(alerts(page.container)).toEqual(["pap could not open the New lane dialog. Reload the page."]);
    },
  );

  it("frees Launch and says something went wrong when opening the new session throws", async () => {
    const bed = fakeRuntime("open");
    bed.handlers["sessions.create"] = () => ({ sessionId: "new-1" });
    current.runtime = bed.runtime;
    const actions = fakeHomeActions();
    actions.open.mockImplementation(() => {
      throw new Error("navigation failed");
    });
    const { page } = await showHome(actions);
    await click(button(page.container, "Launch a session"));
    await vi.waitFor(() => expect(alerts(page.container)).not.toEqual([]), { timeout: 20_000 });
    expect(alerts(page.container)).toEqual(["Something went wrong."]);
    expect(button(page.container, "Launch a session").disabled).toBe(false);
    await act(async () => {
      useCurrentProject.getState().choose("p2");
    });
    expect(alerts(page.container)).toEqual([]);
  });
});
