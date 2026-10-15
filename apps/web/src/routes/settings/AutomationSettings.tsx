import { Button } from "@pap/ui";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useLazyFailureText, useT } from "../../i18n/index.ts";
import { LazyBoundary, notifyLazyFailure, useRetryableLazy } from "../../lib/lazy.tsx";

// One function for the life of the page: `useRetryableLazy` shares the lazy component by it.
const loadAutomation = () =>
  import("../../features/usage/AutomationSection.tsx").then((module) => ({
    default: module.AutomationSection,
  }));

/** Settings › Automation in a chunk of its own. The link to the provider quotas comes from here (a function of its label, which the chunk's own catalog provides). */
export function AutomationSettings() {
  const t = useT();
  const failureText = useLazyFailureText();
  const { Lazy, attempt, retry } = useRetryableLazy(loadAutomation);
  const [failed, setFailed] = useState(false);
  return (
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
              {t("settings.automation.retry")}
            </Button>
          </div>
        ) : (
          <p role="status" className="text-ui text-muted">
            {t("settings.automation.loading")}
          </p>
        )
      }
    >
      <Lazy
        modelsLink={(label: string) => (
          <Link
            to="/settings/$section"
            params={{ section: "models" }}
            className="text-fg underline focus-ring"
          >
            {label}
          </Link>
        )}
      />
    </LazyBoundary>
  );
}
