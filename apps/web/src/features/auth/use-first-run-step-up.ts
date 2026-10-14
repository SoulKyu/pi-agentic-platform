import { useCallback } from "react";
import { getRuntime } from "../../runtime/index.ts";
import { useStepUp } from "./StepUp.tsx";
import { withStepUp } from "./step-up.ts";

/** A call that may need the owner's password again, retried once after the prompt; `null` when cancelled. */
export type PiStepUp = <T>(run: (commandId: string) => Promise<T>) => Promise<T | null>;

/**
 * The password prompt of the Pi step (M7R127). Settings' hook needs the app shell, which does not exist before the
 * first sign-in, so this is the same runner on M5's prompt with the setup flow's own sign-out. `prompt` is rendered once.
 */
export function useFirstRunStepUp(onSignedOut: () => void) {
  const { ask, prompt } = useStepUp(onSignedOut);
  const stepUp = useCallback<PiStepUp>(
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
