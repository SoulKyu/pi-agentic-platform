import { createContext, useContext } from "react";

export interface ShellValue {
  readonly username: string | null;
  readonly passkeysAvailable: boolean;
  onSignedOut(): void;
}

/** What the shell knows about the session, for screens (Settings) that render inside its panes. */
export const ShellContext = createContext<ShellValue | null>(null);

export function useShell(): ShellValue {
  const value = useContext(ShellContext);
  if (value === null) throw new Error("useShell must be used inside the AppShell");
  return value;
}
