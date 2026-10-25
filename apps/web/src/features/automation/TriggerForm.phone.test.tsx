// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_SHELL } from "../../stores/shell-reducer.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import { current, newBed, projectOf, showWithStepUp } from "./board-bed.tsx";
import { knowProject } from "./editor-bed.tsx";
import { TriggerEditor } from "./TriggerEditor.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const NEW_FORM_MS = 20_000;

function phone(on: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: on && query === "(max-width: 767.98px)",
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

beforeEach(() => {
  useTasksStore.getState().reset();
  useShellStore.setState({ view: EMPTY_SHELL });
});
afterEach(() => vi.unstubAllGlobals());

async function columns(on: boolean): Promise<string[]> {
  phone(on);
  newBed();
  knowProject(projectOf("p1", "atlas"));
  const page = await showWithStepUp(
    <TriggerEditor triggerId="new:p1" onOpenSession={vi.fn()} onOpenTasks={vi.fn()} />,
  );
  return [...page.container.querySelectorAll("[data-trigger-editor] [class*='min-w-']")].map(
    (el) => el.className,
  );
}

describe("TriggerForm on a phone", () => {
  it("on a phone the editor's columns drop min-w-pane", { timeout: NEW_FORM_MS }, async () => {
    expect((await columns(true)).filter((c) => /\bmin-w-pane\b/.test(c))).toEqual([]);
  });

  it("on a desktop they keep it", { timeout: NEW_FORM_MS }, async () => {
    expect((await columns(false)).filter((c) => /\bmin-w-pane\b/.test(c))).toHaveLength(3);
  });
});
