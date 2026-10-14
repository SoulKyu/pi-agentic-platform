/**
 * Runs a call that may need the owner's password again. `null`: the person cancelled the prompt (a choice, not an
 * error). The section's host builds it from M5's step-up prompt, so this feature does not import `features/auth`.
 */
// ponytail: the shell now provides this through `lib/step-up-context.tsx` (MC49); migrate this copy when the feature is next touched.
export type StepUpRunner = <T>(run: (commandId: string) => Promise<T>) => Promise<T | null>;
