import { readContext } from "../features/commands/context.ts";

/** What the key dispatcher reads as `overlayOpen` (a menu or a listbox is on the page). */
export const overlayIsOpen = (): boolean =>
  readContext(document, { mobile: false, treeOpen: false }).overlayOpen;
