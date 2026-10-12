// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { EMPTY_VIEW } from "../../stores/session-reducer.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import { field, mount, press, settle, text, type Mounted } from "../../testing/dom.ts";
import { screenBed } from "../../testing/screen-bed.tsx";
import { SessionScreen } from "./SessionScreen.tsx";

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
  };
});

const screen = screenBed(current);
const panelOf = (container: ParentNode) =>
  container.querySelector("[data-terminal-input] textarea") as HTMLTextAreaElement;
const sent = () =>
  screen.bed.called("sessions.panelInput").map((call) => (call.params as { data: string }).data);
const open = async (container: HTMLElement) => {
  (document.activeElement as HTMLElement | null)?.blur();
  await screen.emit({ kind: "panel", panel: { id: "p1", lines: ["> alpha"] } });
  expect(document.activeElement).toBe(panelOf(container));
};

describe("leaving a panel", () => {
  it("gives the focus to the composer when the panel that held it closes", async () => {
    const container = await screen.show({ status: "running" });
    await open(container);
    await screen.emit({ kind: "panel_closed", id: "p1" });
    expect(panelOf(container)).toBeNull();
    expect(document.activeElement).toBe(field(container, "Message"));
  });

  it("leaves the focus alone when the panel closes while it was elsewhere", async () => {
    const container = await screen.show({ status: "running" });
    await open(container);
    const other = document.createElement("button");
    container.append(other);
    other.focus();
    await screen.emit({ kind: "panel_closed", id: "p1" });
    expect(document.activeElement).toBe(other);
  });

  it("moves the focus to the composer on Ctrl+], shows the hint, and never sends the chord", async () => {
    const container = await screen.show({ status: "running" });
    await open(container);
    expect(text(container)).toContain("Ctrl+] to leave the panel");
    const heard: string[] = [];
    const listen = (event: KeyboardEvent) => void heard.push(event.key);
    document.addEventListener("keydown", listen);
    try {
      const chord = await press(panelOf(container), { key: "]", ctrlKey: true });
      expect(chord.defaultPrevented).toBe(true);
      expect(heard).toEqual([]);
    } finally {
      document.removeEventListener("keydown", listen);
    }
    expect(document.activeElement).toBe(field(container, "Message"));
    expect(sent()).toEqual([]);
  });

  it("does not send the Enter that confirms an IME composition, by isComposing or keyCode 229", async () => {
    const container = await screen.show({ status: "running" });
    await open(container);
    await press(panelOf(container), { key: "Enter", isComposing: true });
    await press(panelOf(container), { key: "Enter", keyCode: 229 });
    expect(sent()).toEqual([]);
    await press(panelOf(container), { key: "Enter" });
    expect(sent()).toEqual(["\r"]);
  });

  it("sends a paste of 65536 units whose chunks must shift for surrogate pairs", async () => {
    const container = await screen.show({ status: "running" });
    await open(container);
    const long = `${`${"a".repeat(4095)}\u{1f600}`.repeat(15)}${"b".repeat(4081)}`;
    expect(long).toHaveLength(65_536);
    const { typeInto } = await import("../../testing/dom.ts");
    await typeInto(panelOf(container), long);
    await settle();
    expect(sent().join("")).toBe(long);
    expect(sent().length).toBeGreaterThan(16);
    expect(sent().every((chunk) => chunk.length <= 4096)).toBe(true);
  });
});

describe("two session screens at once", () => {
  let page: Mounted | null = null;
  afterEach(async () => {
    await page?.unmount();
    page = null;
  });

  it("Tab in a composer reaches the panel of its own screen", async () => {
    const withPanel = (id: string) => ({
      ...EMPTY_VIEW,
      status: "idle" as const,
      loaded: true,
      panels: [{ id, lines: [id] }],
    });
    useSessionStore.setState({ views: { "sess-1": withPanel("one"), "sess-2": withPanel("two") } });
    page = await mount(
      <>
        <SessionScreen sessionId="sess-1" />
        <SessionScreen sessionId="sess-2" />
      </>,
    );
    await settle();
    const [first, second] = [...page.container.querySelectorAll("main")];
    const composer = first?.querySelector("[data-composer] textarea") as HTMLTextAreaElement;
    composer.focus();
    await press(composer, { key: "Tab" });
    expect(document.activeElement).toBe(panelOf(first as HTMLElement));
    expect(document.activeElement).not.toBe(panelOf(second as HTMLElement));
  });
});
