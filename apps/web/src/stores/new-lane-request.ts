import type { ModelPick } from "@pap/contracts";
import { create } from "zustand";

/** What "Run again" hands the new lane dialog: the project, the prompt (or issue link) and one model per lane. */
export interface NewLanePrefill {
  readonly projectRoot: string;
  readonly text: string;
  readonly models: ReadonlyArray<ModelPick | null>;
}

interface RequestState {
  readonly prefill: NewLanePrefill | null;
  request(prefill: NewLanePrefill): void;
  /** Reads the request and clears it: a later plain open never sees a stale one. */
  take(): NewLanePrefill | null;
}

/** The compare tab cannot reach the dialog's host (features never import routes): the shell wires both to this. */
export const useNewLaneRequest = create<RequestState>()((set, get) => ({
  prefill: null,
  request: (prefill) => set({ prefill }),
  take: () => {
    const { prefill } = get();
    set({ prefill: null });
    return prefill;
  },
}));
