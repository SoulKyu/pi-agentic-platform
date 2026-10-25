import { Button, LoadingLine } from "@pap/ui";
import { useState } from "react";
import "../../i18n/register-boxes.ts";
import { useLazyFailureText, useT } from "../../i18n/index.ts";
import "../../i18n/register-launch.ts";
import { usePiCauseText } from "../../stores/loading-cause.ts";
import { LazyBoundary, notifyLazyFailure, useRetryableLazy } from "../../lib/lazy.tsx";
import { useWaitStart, WaitSinceProvider } from "../../lib/wait-since.tsx";
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
  const cause = usePiCauseText(t);
  const failureText = useLazyFailureText();
  const { stepUp, prompt } = useSettingsStepUp();
  const project = useEffectiveProject();
  // A box project's own MCP servers are not available yet (a helper would open its host path): the global list only.
  const inBox = project?.kind === "box";
  const cwd = inBox ? undefined : project?.root;
  const { Lazy, attempt, retry } = useRetryableLazy(loadMcp);
  const wait = useWaitStart(attempt);
  const [failed, setFailed] = useState(false);

  return (
    <>
      <WaitSinceProvider value={wait}>
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
              <LoadingLine
                label={t("settings.mcp.loading")}
                since={wait.since}
                deferred={false}
                cause={cause}
              />
            )
          }
        >
          <Lazy stepUp={stepUp} cwd={cwd} />
        </LazyBoundary>
      </WaitSinceProvider>
      {inBox ? (
        <p role="note" className="text-ui text-muted">
          {t("boxes.off")}
        </p>
      ) : null}
      {prompt}
    </>
  );
}
