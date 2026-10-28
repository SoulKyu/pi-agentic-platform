import { create } from "zustand";

const MAX_KEPT = 32;

/** Where one block stands: `since` is when a click started (null when none runs), `answer` the last result. */
interface ShellStatus {
  readonly since: number | null;
  readonly answer: { readonly ok: boolean; readonly text: string } | null;
}

export const IDLE: ShellStatus = { since: null, answer: null };

interface ShellAnswersState {
  readonly byBlock: Readonly<Record<string, ShellStatus>>;
  set(block: string, status: ShellStatus): void;
  reset(): void;
}

/**
 * Where each shell block's hand-off stands, by session and block. Opening the terminal splits the tab and a phone swaps
 * panes, so the chat mounts again while the click runs: the status cannot live in the block. At most 32 are kept.
 */
export const useShellAnswers = create<ShellAnswersState>()((set, get) => ({
  byBlock: {},
  set(block, status) {
    const kept = Object.entries(get().byBlock).filter(([key]) => key !== block);
    set({ byBlock: Object.fromEntries([...kept.slice(-(MAX_KEPT - 1)), [block, status]]) });
  },
  reset: () => set({ byBlock: {} }),
}));
