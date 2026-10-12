// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { button, click, field, mount, press, settle, typeInto, type Mounted } from "../../testing/dom.ts";
import { screenBed, seedSessionViews } from "../../testing/screen-bed.tsx";
import { sessionSnapshot } from "../../testing/session-snapshot.ts";
import { DEFAULT_KEYBINDINGS, KNOWN_COMMANDS } from "../../features/commands/defaults.ts";
import { installDispatcher } from "../../features/commands/dispatcher.ts";
import { mergeWithDefaults } from "../../features/commands/resolve.ts";
import { SessionScreen } from "../../features/sessions/SessionScreen.tsx";

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
const { rules } = mergeWithDefaults(DEFAULT_KEYBINDINGS, [], KNOWN_COMMANDS);
let uninstall: () => void = () => {};
beforeEach(() => {
  // The real dispatcher with the real defaults: the chord, the `when` clause and the handler are all under test.
  uninstall = installDispatcher({
    win: window,
    platform: "other",
    rules: () => rules,
    shell: () => ({ mobile: false, treeOpen: false }),
  });
});
afterEach(() => {
  uninstall();
  document.querySelectorAll("[data-test-menu]").forEach((node) => node.remove());
});

/** The screen as the shell hosts it: inside a pane of kind "session". */
const inPane = (children: ReactNode) => <div data-pane-kind="session">{children}</div>;
const escape = (target: Element) => press(target, { key: "Escape", code: "Escape" });
const aborted = () => screen.bed.called("sessions.abort");
const mount1 = async (patch: Record<string, unknown>) => {
  const container = await screen.remount(inPane(<SessionScreen sessionId="sess-1" />));
  await screen.emit(sessionSnapshot(patch));
  return container;
};
const approval = {
  id: "a1",
  method: "approval",
  title: "Run a command?",
  message: "1 line\nbash: ls",
  category: "exec",
  answers: ["deny", "once"],
};

describe("Escape stops the run (agreement 7)", () => {
  it("stops a running session from the composer, and says nothing to the page", async () => {
    const container = await mount1({ status: "running" });
    const composer = field(container, "Message");
    composer.focus();
    const event = await escape(composer);
    expect(event.defaultPrevented).toBe(true);
    expect(aborted()).toHaveLength(1);
  });

  it("leaves Escape alone when nothing runs", async () => {
    const container = await mount1({ status: "idle" });
    const composer = field(container, "Message");
    composer.focus();
    expect((await escape(composer)).defaultPrevented).toBe(false);
    expect(aborted()).toHaveLength(0);
  });

  it("does not stop the run while the focus is in the extension's custom panel", async () => {
    const container = await mount1({ status: "running" });
    await screen.emit({ kind: "panel", panel: { id: "p1", lines: ["> alpha"] } });
    const panel = container.querySelector("[data-terminal-input] textarea") as HTMLTextAreaElement;
    expect(document.activeElement).toBe(panel);
    await escape(panel);
    expect(aborted()).toHaveLength(0);
    // The key went to the panel (its own handler), as the terminal expects.
    expect(
      screen.bed.called("sessions.panelInput").map((call) => (call.params as { data: string }).data),
    ).toEqual(["\u001b"]);
  });

  it("does not stop the run while a menu is open", async () => {
    const container = await mount1({ status: "running" });
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    menu.setAttribute("data-test-menu", "");
    document.body.append(menu);
    const composer = field(container, "Message");
    composer.focus();
    expect((await escape(composer)).defaultPrevented).toBe(false);
    expect(aborted()).toHaveLength(0);
  });

  it("does not stop the run from the rename field, and cancels the rename instead", async () => {
    const container = await mount1({ status: "running" });
    await click(button(container, "Rename"));
    const name = field(container, "Rename");
    name.focus();
    await escape(name);
    expect(aborted()).toHaveLength(0);
    expect(container.querySelector("[data-inline-edit]")).toBeNull();
  });

  it("does not stop the run from inside an extension's dialog", async () => {
    const container = await mount1({
      status: "running",
      dialogs: [{ id: "s1", method: "select", title: "Pick one", options: ["a", "b"] }],
    });
    const choice = button(container, "a");
    choice.focus();
    expect((await escape(choice)).defaultPrevented).toBe(false);
    expect(aborted()).toHaveLength(0);
  });

  it("does not stop the run from inside the approval card", async () => {
    const container = await mount1({ status: "running", dialogs: [approval] });
    const deny = button(container, "Deny");
    deny.focus();
    expect((await escape(deny)).defaultPrevented).toBe(false);
    expect(aborted()).toHaveLength(0);
    // The same key from outside the card still stops the run.
    const composer = field(container, "Message");
    composer.focus();
    await escape(composer);
    expect(aborted()).toHaveLength(1);
  });
});

describe("Mod+Shift+Enter sends the other way", () => {
  const sendOther = (target: Element) =>
    press(target, { key: "Enter", code: "Enter", ctrlKey: true, shiftKey: true });
  const prompts = () => screen.bed.called("sessions.prompt").map((call) => call.params);

  it("follows up when steering is the way, and steers when follow-up is", async () => {
    const container = await mount1({ status: "running" });
    const composer = field(container, "Message");
    await typeInto(composer, "check the tests");
    composer.focus();
    const event = await sendOther(composer);
    await settle();
    expect(event.defaultPrevented).toBe(true);
    expect(prompts()).toEqual([
      { sessionId: "sess-1", text: "check the tests", streamingBehavior: "followUp" },
    ]);
    await typeInto(composer, "and the lint");
    await sendOther(composer);
    await settle();
    expect(prompts().at(-1)).toEqual({
      sessionId: "sess-1",
      text: "and the lint",
      streamingBehavior: "steer",
    });
  });

  it("sends nothing from an empty field", async () => {
    const container = await mount1({ status: "running" });
    const composer = field(container, "Message");
    composer.focus();
    await sendOther(composer);
    await settle();
    expect(prompts()).toEqual([]);
  });

  it("does not fire from an extension's custom panel", async () => {
    const container = await mount1({ status: "running" });
    await typeInto(field(container, "Message"), "kept");
    await screen.emit({ kind: "panel", panel: { id: "p1", lines: ["> alpha"] } });
    const panel = container.querySelector("[data-terminal-input] textarea") as HTMLTextAreaElement;
    await sendOther(panel);
    await settle();
    expect(prompts()).toEqual([]);
  });
});

describe("two session screens at once", () => {
  let page: Mounted | null = null;
  afterEach(async () => {
    await page?.unmount();
    page = null;
  });

  it("stops the run of the screen that holds the focus, not the other", async () => {
    seedSessionViews({ "sess-1": { status: "running" }, "sess-2": { status: "running" } });
    current.runtime = screen.bed.runtime;
    page = await mount(
      <div data-pane-kind="session">
        <SessionScreen sessionId="sess-1" />
        <SessionScreen sessionId="sess-2" />
      </div>,
    );
    await settle();
    const [first, second] = [...page.container.querySelectorAll("[data-session-screen]")];
    // The second screen registered last, so only the focus check can send the key to the first.
    const firstComposer = first?.querySelector("[data-composer] textarea") as HTMLTextAreaElement;
    firstComposer.focus();
    await escape(firstComposer);
    expect(screen.bed.called("sessions.abort").map((call) => call.params)).toEqual([{ sessionId: "sess-1" }]);
    const secondComposer = second?.querySelector("[data-composer] textarea") as HTMLTextAreaElement;
    secondComposer.focus();
    await escape(secondComposer);
    expect(screen.bed.called("sessions.abort").map((call) => call.params)).toEqual([
      { sessionId: "sess-1" },
      { sessionId: "sess-2" },
    ]);
  });
});
