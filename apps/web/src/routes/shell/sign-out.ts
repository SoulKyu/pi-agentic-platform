import { toast } from "@pap/ui";
import { logout } from "../../features/auth/auth-api.ts";
import { t } from "../../i18n/index.ts";
import { getRuntime, windowTimers } from "../../runtime/index.ts";

const RELEASE_DEADLINE_MS = 3_000;

/**
 * This device's push subscription goes first (M12R12): revoking needs the session that logout ends. It loads the push
 * code only when the permission is granted, never delays sign-out past the deadline, and never blocks it on a failure.
 */
function releasePush(): Promise<void> {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = windowTimers.set(resolve, RELEASE_DEADLINE_MS);
    void import("../../features/notifications/start.ts")
      .then((start) => start.releaseThisDevice(getRuntime().rpc, windowTimers))
      .catch(() => {})
      .finally(() => {
        windowTimers.clear(timer);
        resolve();
      });
  });
}

/** The one sign-out: the rail's menu and the `auth.signOut` command both run it. */
export function signOut(onSignedOut: () => void): void {
  void releasePush()
    .then(() => logout())
    .then(onSignedOut, () => toast({ message: t("shell.signOutFailed"), tone: "error" }));
}
