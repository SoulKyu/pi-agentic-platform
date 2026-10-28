import type { CONTEXT_KEYS } from "./defaults.ts";

export interface ShellContext {
  readonly mobile: boolean;
  readonly treeOpen: boolean;
}

const EDITABLE = 'input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"]';

/** Radix popper content (menus, selects, popovers) or a menu or listbox, but never a mere tooltip. */
function overlayOpen(doc: Document): boolean {
  // A floating selection bar (the quote toolbar and strip, UX-1; the name stays neutral so the lazy chunk's markers stay out of this eager file): Escape closes them first and the next one stops the run.
  if (doc.querySelector('[role="menu"], [role="listbox"], [data-closes-on-escape]')) return true;
  return [...doc.querySelectorAll("[data-radix-popper-content-wrapper]")].some(
    (wrapper) => wrapper.querySelector('[role="tooltip"]') === null,
  );
}

/** The `when` context of one key event, read from the page (T3 lib/editableFocus.ts; agreement 7). */
export function readContext(
  doc: Document,
  shell: ShellContext,
): Record<(typeof CONTEXT_KEYS)[number], boolean> {
  const active = doc.activeElement instanceof Element ? doc.activeElement : null;
  return {
    editableFocus: active?.closest(EDITABLE) != null,
    dialogOpen: doc.querySelector('[data-pap-modal][data-state="open"]') !== null,
    overlayOpen: overlayOpen(doc),
    panelFocus: active?.closest("[data-terminal-input]") != null,
    // A rename field, an extension's dialog or an approval: Escape cancels or closes it and never stops the run.
    inlineEditFocus: active?.closest("[data-inline-edit]") != null,
    paletteOpen: doc.querySelector("[data-command-palette]") !== null,
    treeOpen: shell.treeOpen,
    sessionFocus: active?.closest('[data-pane-kind="session"]') != null,
    mobile: shell.mobile,
  };
}
