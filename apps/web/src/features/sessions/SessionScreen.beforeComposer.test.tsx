// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { screenBed } from "../../testing/screen-bed.tsx";
import { SessionScreen } from "./SessionScreen.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const screen = screenBed(current);
beforeEach(() => vi.useRealTimers());

describe("SessionScreen: beforeComposer (M9R64)", () => {
  it("renders it right above the composer", async () => {
    const container = await screen.remount(
      <SessionScreen sessionId="sess-1" beforeComposer={<p data-before>banner</p>} />,
    );
    const order = [...container.querySelectorAll("[data-before], textarea")].map((node) =>
      node.hasAttribute("data-before") ? "before" : "composer",
    );
    expect(order).toEqual(["before", "composer"]);
  });

  it("renders nothing extra without it", async () => {
    const container = await screen.remount(<SessionScreen sessionId="sess-1" />);
    expect(container.querySelector("[data-before]")).toBeNull();
  });
});
