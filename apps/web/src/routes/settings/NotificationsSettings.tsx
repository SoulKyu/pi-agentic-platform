import { Button } from "@pap/ui";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useLazyFailureText, useT } from "../../i18n/index.ts";
import { LazyBoundary, notifyLazyFailure, useRetryableLazy } from "../../lib/lazy.tsx";

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
              {t("settings.notifications.retry")}
            </Button>
          </div>
        ) : (
          <p role="status" className="text-ui text-muted">
            {t("settings.notifications.loading")}
          </p>
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
  );
}
