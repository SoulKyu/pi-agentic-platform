import { useT } from "../../i18n/index.ts";
import { useVmStatus } from "../../lib/use-vm-status.ts";

/** The dry-run's profile of an agent's isolated task (M11R127): whether the VM stack is ready, and where it may write. */
export function IsolatedProfile() {
  const t = useT();
  const { status } = useVmStatus();
  const state = status === null ? "checking" : status.usable ? "on" : "unavailable";
  return (
    <p className="text-muted">
      {t("automation.dry.isolatedTask", { state: t(`automation.dry.sandbox.${state}`) })}
    </p>
  );
}
