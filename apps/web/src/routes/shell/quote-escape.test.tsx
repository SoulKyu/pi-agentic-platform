// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCommand } from "../../lib/command-registry.ts";
import { DEFAULT_KEYBINDINGS, KNOWN_COMMANDS } from "../../features/commands/defaults.ts";
import { installDispatcher } from "../../features/commands/dispatcher.ts";
import { mergeWithDefaults } from "../../features/commands/resolve.ts";
import { QuoteToolbar } from "../../features/sessions/quote/QuoteToolbar.tsx";
import { setLocale } from "../../i18n/index.ts";
import { mount, press, settle } from "../../testing/dom.ts";
import { clearSelection, QuoteFixture, select } from "../../testing/quote-bed.tsx";

const { rules } = mergeWithDefaults(DEFAULT_KEYBINDINGS, [], KNOWN_COMMANDS);
let uninstall: () => void = () => {};
let unregister: () => void = () => {};
const stop = vi.fn();

beforeEach(() => {
  setLocale("en");
  stop.mockReset();
  unregister = registerCommand("session.stop", stop);
  uninstall = installDispatcher({
    win: window,
    platform: "other",
    rules: () => rules,
    shell: () => ({ mobile: false, treeOpen: false }),
  });
});
afterEach(async () => {
  uninstall();
  unregister();
  await clearSelection();
});

const show = () =>
  mount(
    <QuoteFixture>
      <QuoteToolbar sessionId="s1" />
    </QuoteFixture>,
  );
const toolbar = () => document.querySelector("[data-quote-toolbar]");

// The shortcut layer belongs to the commands feature: a session test may not import it, so this one lives with the shell.
describe("Escape with the quote toolbar", () => {
  it("Escape closes the toolbar and the session.stop command does not run", async () => {
    await show();
    const composer = document.getElementById("composer") as HTMLTextAreaElement;
    composer.focus();
    await select("reply-1");
    expect(toolbar()).not.toBeNull();
    await press(composer, { key: "Escape", code: "Escape" });
    await settle();
    expect(stop).not.toHaveBeenCalled();
    expect(toolbar()).toBeNull();
    expect(document.getSelection()?.rangeCount).toBe(0);
    await press(composer, { key: "Escape", code: "Escape" });
    expect(stop).toHaveBeenCalledOnce();
  });

  it("Escape from the transcript closes the toolbar too, and the next one stops the run", async () => {
    await show();
    const reply = document.getElementById("reply-1") as HTMLElement;
    reply.tabIndex = -1;
    reply.focus();
    await select("reply-1");
    await press(reply, { key: "Escape", code: "Escape" });
    await settle();
    expect(stop).not.toHaveBeenCalled();
    expect(toolbar()).toBeNull();
    await press(reply, { key: "Escape", code: "Escape" });
    expect(stop).toHaveBeenCalledOnce();
  });
});
