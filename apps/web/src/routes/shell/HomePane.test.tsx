// @vitest-environment happy-dom
import { act } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LAST_PRESET_KEY } from "../../features/sessions/presets.vm.ts";
import type { Runtime } from "../../runtime/index.ts";
import { useCurrentProject } from "../../stores/current-project.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { button, click, mount, settle } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { shellProject, shellSnapshot } from "../../testing/shell-snapshot.ts";
import { HomePane } from "./HomePane.tsx";

const current = vi.hoisted(() => ({
  runtime: undefined as Runtime | undefined,
  navigate: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("../../features/home/HomeBody.tsx", () => ({ default: () => null }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => current.navigate,
}));

let bed: ReturnType<typeof fakeRuntime>;
const select = () => document.querySelector('[role="combobox"]') as HTMLElement;
async function choose(label: string) {
  await act(async () => {
    select().dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }),
    );
  });
  await vi.waitFor(() => expect(document.querySelector('[role="listbox"]')).not.toBeNull(), {
    timeout: 2_000,
  });
  const option = [...document.querySelectorAll('[role="option"]')].find((one) => one.textContent === label);
  await act(async () => {
    option?.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerType: "mouse" }));
    (option as HTMLElement).click();
  });
  await vi.waitFor(() => expect(document.querySelector('[role="listbox"]')).toBeNull(), { timeout: 2_000 });
  await settle();
}

// The picker is a lazy chunk: the first transform of its select stack is slow, so it is paid here, not in a test.
beforeAll(async () => {
  await import("../../features/sessions/PresetPicker.tsx");
  await import("../../features/home/run-launch.ts");
}, 60_000);
beforeEach(() => {
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  bed.handlers["lanes.preview"] = () => ({ repo: true });
  bed.handlers["sessions.create"] = () => ({ sessionId: "n1" });
  localStorage.clear();
  useShellStore.getState().reset();
  useShellStore
    .getState()
    .apply(
      shellSnapshot([], { projects: [shellProject({ id: "p1", name: "api", root: "/w/api", sessions: 1 })] }),
    );
  useCurrentProject.setState({ projectId: "p1", storageRefused: false, startedHere: 0 });
  current.navigate.mockClear();
});

describe("the home pane (the shell's side of the home)", () => {
  it("sends the preset chosen under Session options, remembers it for this device, and opens the session", async () => {
    const page = await mount(<HomePane />);
    await settle();
    await click(button(page.container, "Session options"));
    await act(async () => {
      await vi.waitFor(() => expect(select()).not.toBeNull(), { timeout: 10_000 });
    });
    expect(select().textContent).toBe("Configured");
    await choose("Read-only");
    expect(localStorage.getItem(LAST_PRESET_KEY)).toBe("read-only");
    await click(button(page.container, "Launch a session"));
    await settle();
    expect(bed.called("sessions.create")[0]?.params).toEqual({ cwd: "/w/api", preset: "read-only" });
    expect(current.navigate).toHaveBeenCalledWith({ to: "/s/n1" });
  });

  it("opens the tasks stream while the home shows, and closes it when the home goes (§8)", async () => {
    const page = await mount(<HomePane />);
    await settle();
    expect(bed.called("subscribe.tasks")).toHaveLength(1);
    await page.unmount();
    expect(bed.called("unsubscribe")).toHaveLength(1);
  });
});
