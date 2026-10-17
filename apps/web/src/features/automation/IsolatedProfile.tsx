import type { SandboxStatus } from "@pap/contracts";
import { useEffect, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";

/** The dry-run's profile of an agent's isolated task (M11R127): the host's sandbox state, and where it may write. */
export function IsolatedProfile() {
  const t = useT();
  const [status, setStatus] = useState<Pick<SandboxStatus, "usable" | "checkedAt"> | "unread" | null>(null);
  useEffect(() => {
    let live = true;
    getRuntime()
      .rpc.call("agents.sandboxStatus", {})
      .then(
        (next) => live && setStatus(next),
        () => live && setStatus("unread"),
      );
    return () => {
      live = false;
    };
  }, []);
  const state =
    status === "unread"
      ? "unread"
      : status === null || status.checkedAt === 0
        ? "checking"
        : status.usable
          ? "on"
          : "unavailable";
  return (
    <p className="text-muted">
      {t("automation.dry.isolatedTask", { state: t(`automation.dry.sandbox.${state}`) })}
    </p>
  );
}
