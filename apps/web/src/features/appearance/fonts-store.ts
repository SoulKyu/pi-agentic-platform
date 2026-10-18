import type { FontFamilyView } from "@pap/contracts";
import { create } from "zustand";
import type { RpcClient } from "../../runtime/rpc.ts";

interface FontsState {
  /** null until `fonts.list` has answered: a custom choice is not called "removed" before then. */
  readonly families: readonly FontFamilyView[] | null;
  setFamilies(families: readonly FontFamilyView[]): void;
}

export const useFontsStore = create<FontsState>()((set) => ({
  families: null,
  setFamilies: (families) => set({ families }),
}));

/** Reads the installed families into the store. A failed read leaves the store as it was (the default font shows). */
export async function loadFonts(rpc: Pick<RpcClient, "call">): Promise<boolean> {
  try {
    const { families } = await rpc.call("fonts.list", {});
    if (!Array.isArray(families)) return false;
    useFontsStore.getState().setFamilies(families);
    return true;
  } catch {
    return false;
  }
}
