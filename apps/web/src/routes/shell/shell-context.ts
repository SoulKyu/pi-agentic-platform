import { createContext, useContext } from "react";

export interface ShellValue {
  readonly username: string | null;
  readonly passkeysAvailable: boolean;
  onSignedOut(): void;
}

/** What the shell knows about the session, for screens (Settings) that render inside its panes. */
export const ShellContext = createContext<ShellValue>({
  username: null,
  passkeysAvailable: false,
  onSignedOut: () => {},
});

export const useShell = (): ShellValue => useContext(ShellContext);
