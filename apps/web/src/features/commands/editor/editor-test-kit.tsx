import type { KeybindingRule } from "@pap/contracts";
import { Toaster, TooltipProvider } from "@pap/ui";
import { afterEach, beforeEach, vi } from "vitest";
import { settingsScreenEn, settingsScreenFr } from "../../../i18n/catalog/settings-screen.ts";
import { settingsShortcutsEn, settingsShortcutsFr } from "../../../i18n/catalog/settings-shortcuts.ts";
import { registerCatalog, setLocale } from "../../../i18n/index.ts";
import { button, click, mount, text } from "../../../testing/dom.ts";
import { DEFAULT_KEYBINDINGS, KNOWN_COMMANDS } from "../defaults.ts";
import { useKeybindingsStore } from "../keybindings-store.ts";
import { mergeWithDefaults } from "../resolve.ts";
import { ShortcutsEditor } from "./ShortcutsEditor.tsx";

registerCatalog({ en: settingsScreenEn, fr: settingsScreenFr });
registerCatalog({ en: settingsShortcutsEn, fr: settingsShortcutsFr });

export const seed = (user: readonly KeybindingRule[] = []) =>
  useKeybindingsStore.setState({
    user,
    ...mergeWithDefaults(DEFAULT_KEYBINDINGS, user, KNOWN_COMMANDS),
    status: "local",
  });

let cleanups: Array<() => void> = [];
/** Runs `fn` after the current test. */
export const later = (fn: () => void): void => {
  cleanups.push(fn);
};

/** A fresh store before each test; timers, spies, globals and locale restored after it. */
export function installEditorTestHooks(): void {
  beforeEach(() => {
    localStorage.clear();
    seed();
  });
  afterEach(() => {
    cleanups.forEach((fn) => fn());
    cleanups = [];
    setLocale("en");
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
}

export const render = () =>
  mount(
    <TooltipProvider>
      <Toaster closeLabel="Close" regionLabel="Notifications" />
      <div data-pane-kind="session">
        <div tabIndex={0} data-testid="outside" />
        <ShortcutsEditor platform="other" />
      </div>
    </TooltipProvider>,
  );

export const row = (container: ParentNode, id: string): HTMLElement => {
  const found = container.querySelector<HTMLElement>(`[data-command="${id}"]`);
  if (found === null) throw new Error(`no row for ${id}`);
  return found;
};
export const rowText = (container: ParentNode, id: string) => text(row(container, id));
export const start = async (container: ParentNode, id: string) => {
  const recorder = button(row(container, id), "Change");
  await click(recorder);
  return recorder;
};
export const ctrl = (key: string, code: string, extra: KeyboardEventInit = {}): KeyboardEventInit => ({
  key,
  code,
  ctrlKey: true,
  ...extra,
});
