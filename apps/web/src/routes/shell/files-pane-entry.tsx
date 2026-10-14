import { FilesPane } from "../../features/files/FilesPane.tsx";
import { useStepUp } from "../../features/auth/StepUp.tsx";
import { withStepUp } from "../../features/auth/step-up.ts";
import { useShell } from "./shell-context.ts";

/**
 * The files pane with the password prompt of the auth feature (M8R117): features never import each other, so the
 * shell joins them. Loaded lazily with the pane, which keeps the prompt out of the initial bundle.
 */
export function FilesPaneEntry({ root }: { readonly root: string }) {
  const { onSignedOut } = useShell();
  const { ask, prompt } = useStepUp(onSignedOut);
  return (
    <FilesPane
      root={root}
      stepUp={{ run: (attempt, commandId) => withStepUp(attempt, ask, commandId), prompt }}
    />
  );
}
