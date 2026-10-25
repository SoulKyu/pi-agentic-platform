import { createContext, type ReactNode, useContext } from "react";
import { createPortal } from "react-dom";

/** The header slot of the Settings screen: `undefined` outside it (the toolbar then draws in place), `null` until it mounts. */
export const SettingsToolbarSlot = createContext<HTMLElement | null | undefined>(undefined);

/** Puts a section's actions in the header beside the h1, so the section needs no title row of its own. */
export function SettingsToolbar({ children }: { readonly children: ReactNode }) {
  const slot = useContext(SettingsToolbarSlot);
  if (slot === undefined) return <>{children}</>;
  return slot === null ? null : createPortal(children, slot);
}
