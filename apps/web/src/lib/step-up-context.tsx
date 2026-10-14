import { createContext, useContext } from "react";

/**
 * Runs a call that may need the owner's password again, retried once after the shell's inline prompt. `null`: the
 * person cancelled the prompt (a choice, not an error).
 */
export type StepUpRunner = <T>(run: (commandId: string) => Promise<T>) => Promise<T | null>;

/** Provided by the shell, which renders the one prompt, so a feature never imports the auth feature or `routes/` (MC49). */
export const StepUpContext = createContext<StepUpRunner | null>(null);

export function useStepUpRunner(): StepUpRunner {
  const runner = useContext(StepUpContext);
  if (runner === null) throw new Error("useStepUpRunner must be used inside the AppShell");
  return runner;
}
