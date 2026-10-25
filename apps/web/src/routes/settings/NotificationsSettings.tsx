import { Button, LoadingLine } from "@pap/ui";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useLazyFailureText, useT } from "../../i18n/index.ts";
import { LazyBoundary, notifyLazyFailure, useRetryableLazy } from "../../lib/lazy.tsx";
import { useWaitStart, WaitSinceProvider } from "../../lib/wait-since.tsx";

// One function for the life of the page: `useRetryableLazy` shares the lazy component by it.
const loadNotifications = () =>
  import("../../features/notifications/NotificationsPanel.tsx").then((module) => ({
    default: module.NotificationsPanel,
  }));

/** Settings › Notifications in a chunk of its own (M12): the first paint never carries the push client or its copy. */
export function NotificationsSettings() {
  const t = useT();
  const failureText = useLazyFailureText();
  const { Lazy, attempt, retry } = useRetryableLazy(loadNotifications);
  const wait = useWaitStart(attempt);
  const [failed, setFailed] = useState(false);
  return (
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
                {t("settings.notifications.retry")}
              </Button>
            </div>
          ) : (
            <LoadingLine label={t("settings.notifications.loading")} since={wait.since} deferred={false} />
          )
        }
      >
        <Lazy
          automationLink={(label: string) => (
            <Link
              to="/settings/$section"
              params={{ section: "automation" }}
              className="text-fg underline focus-ring"
            >
              {label}
            </Link>
          )}
        />
      </LazyBoundary>
    </WaitSinceProvider>
  );
}
