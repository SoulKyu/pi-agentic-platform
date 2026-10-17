import { create } from "zustand";

interface SecretDialogState {
  /** The secret request the dialog is open for. The request itself is read from the `agents` store; the value is never here. */
  readonly requestId: string | null;
  open(requestId: string): void;
  /** Close, and sign-out (MC34). */
  close(): void;
}

/** Whether the secret dialog is open and for which request: no value, no draft (M11R130). */
export const useSecretDialog = create<SecretDialogState>()((set) => ({
  requestId: null,
  open: (requestId) => set({ requestId }),
  close: () => set({ requestId: null }),
}));
