import { Button } from "@pap/ui";
import { useState } from "react";
import { useLazyFailureText, useT } from "../../i18n/index.ts";
import { LazyBoundary, notifyLazyFailure, useRetryableLazy } from "../../lib/lazy.tsx";
import { useEffectiveProject } from "../../stores/current-project.ts";
import { useSettingsStepUp } from "./use-settings-step-up.ts";

// One function for the life of the page: `useRetryableLazy` shares the lazy component by it.
const loadMcp = () =>
  import("../../features/mcp/McpSection.tsx").then((module) => ({ default: module.McpSection }));

/**
 * Settings › MCP in a chunk of its own (M7R99). The folder is the project the switcher shows. This host owns the password prompt, so the feature does not import
 * the auth feature: it is handed a runner that retries once after M5's inline prompt (M7R70).
 */
export function McpSettings() {
  const t = useT();
  const failureText = useLazyFailureText();
  const { stepUp, prompt } = useSettingsStepUp();
  const cwd = useEffectiveProject()?.root;
  const { Lazy, attempt, retry } = useRetryableLazy(loadMcp);
  const [failed, setFailed] = useState(false);

  return (
    <>
      <LazyBoundary
        resetKey={attempt}
        onError={(error) => {
          setFailed(true);
          notifyLazyFailure(error, failureText);
        }}
        fallback={
          failed ? (
            <div>
              <Button
                onClick={() => {
                  setFailed(false);
                  retry();
                }}
              >
                {t("settings.mcp.retry")}
              </Button>
            </div>
          ) : (
            <p role="status" className="text-ui text-muted">
              {t("settings.mcp.loading")}
            </p>
          )
        }
      >
        <Lazy stepUp={stepUp} cwd={cwd} />
      </LazyBoundary>
      {prompt}
    </>
  );
}
