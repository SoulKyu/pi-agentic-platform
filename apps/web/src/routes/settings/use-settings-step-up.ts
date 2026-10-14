import { useCallback } from "react";
import { useStepUp } from "../../features/auth/StepUp.tsx";
import { withStepUp } from "../../features/auth/step-up.ts";
import { getRuntime } from "../../runtime/index.ts";
import { useShell } from "../shell/shell-context.ts";

/** A call that may need the owner's password again, retried once after M5's inline prompt; `null` when cancelled. */
export type SettingsStepUp = <T>(run: (commandId: string) => Promise<T>) => Promise<T | null>;

/**
 * The password prompt of a lazy Settings section (M7R70): the section's host owns the prompt, so the feature never
 * imports the auth feature. `prompt` is rendered once beside the section.
 */
export function useSettingsStepUp() {
  const { onSignedOut } = useShell();
  const { ask, prompt } = useStepUp(onSignedOut);
  const stepUp = useCallback<SettingsStepUp>(
    async <T>(run: (commandId: string) => Promise<T>) => {
      let cancelled = false;
      try {
        return await withStepUp(
          run,
          async () => {
            const confirmed = await ask();
            cancelled = !confirmed;
            return confirmed;
          },
          getRuntime().rpc.newCommandId(),
        );
      } catch (failure) {
        if (cancelled) return null;
        throw failure;
      }
    },
    [ask],
  );
  return { stepUp, prompt };
}
