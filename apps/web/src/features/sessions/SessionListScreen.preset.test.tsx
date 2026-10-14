// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { button, click, field, mount, settle, text, typeInto } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { useCurrentProject } from "../../stores/current-project.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { LAST_PRESET_KEY } from "./presets.vm.ts";
import { SessionListScreen } from "./SessionListScreen.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../lib/command-registry.ts", () => ({ runCommand: vi.fn() }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return {
    useNavigate: () => () => Promise.resolve(),
    Link: (props: { children: ReactNode }) => createElement("a", {}, props.children),
  };
});

let bed: ReturnType<typeof fakeRuntime>;
const trigger = () => document.querySelector('[role="combobox"]') as HTMLElement;

async function choose(label: string) {
  await act(async () => {
    trigger().dispatchEvent(
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
async function show() {
  bed = fakeRuntime();
  current.runtime = bed.runtime;
  const page = await mount(<SessionListScreen />);
  await act(async () => {
    await vi.waitFor(() => expect(trigger()).not.toBeNull(), { timeout: 10_000 });
  });
  return page.container;
}

// The picker is a lazy chunk: the first transform of its select stack is slow, so it is paid here, not in a test.
beforeAll(async () => {
  await import("./PresetPicker.tsx");
}, 60_000);

beforeEach(() => {
  setLocale("en");
  localStorage.clear();
  useShellStore.getState().reset();
  useCurrentProject.setState({ projectId: null, storageRefused: false });
});
afterEach(() => setLocale("en"));

describe("new-session form preset", () => {
  it("starts on Configured, says what the choice allows, and sends the chosen preset in sessions.create", async () => {
    const container = await show();
    expect(trigger().textContent).toBe("Configured");
    await choose("Read-only");
    expect(text(container)).toContain("Reads run. Anything else asks every time, even in full access.");
    bed.handlers["sessions.create"] = () => ({ sessionId: "n1" });
    await typeInto(field(container, "Working directory"), "/work/p");
    await click(button(container, "New session"));
    await settle();
    expect(bed.called("sessions.create")[0]?.params).toEqual({ cwd: "/work/p", preset: "read-only" });
  });

  it("remembers the last explicit choice for the next form on this browser", async () => {
    await show();
    await choose("Chat only");
    expect(localStorage.getItem(LAST_PRESET_KEY)).toBe("chat");
    const container = await show();
    expect(trigger().textContent).toBe("Chat only");
    bed.handlers["sessions.create"] = () => ({ sessionId: "n2" });
    await typeInto(field(container, "Working directory"), "/work/q");
    await click(button(container, "New session"));
    await settle();
    expect(bed.called("sessions.create")[0]?.params).toEqual({ cwd: "/work/q", preset: "chat" });
  });

  it("labels the field in French", async () => {
    setLocale("fr");
    await show();
    expect(trigger().textContent).toBe("Configuré");
  });
});
