import { useEffect } from "react";
import type { StepUpRunner } from "../../lib/step-up-context.tsx";
import { useSettingsStepUp } from "../settings/use-settings-step-up.ts";

/** The lazy half of `StepUpHost`: the runner and the password prompt, handed to the host once mounted. */
export function StepUpEngine({ register }: { register(runner: StepUpRunner | null): void }) {
  const { stepUp, prompt } = useSettingsStepUp();
  useEffect(() => {
    register(stepUp);
    return () => register(null);
  }, [register, stepUp]);
  return prompt;
}
