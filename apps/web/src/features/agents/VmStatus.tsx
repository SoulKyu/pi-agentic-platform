import "./register-agent-catalog.ts";
import type { VmStatusView } from "@pap/contracts";
import { Button } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import { stripHidden } from "../../lib/untrusted-text.ts";

/**
 * Settings › Agents › Agent VMs, in place of the sandbox when agents run in VMs: whether they can start and, when they
 * cannot, what to run (R6) and the daemon's reason. Same layout as `SandboxStatus` (no board of its own). The reason is
 * the daemon's text: drawn as text, hidden characters removed.
 */
export function VmStatus({ status, reload }: { readonly status: VmStatusView; reload(): void }) {
  const t = useT();
  const running = status.agents.filter((agent) => agent.phase === "running").length;
  return (
    <section data-slot="agents-vm" aria-labelledby="agents-vm-title" className="flex flex-col gap-s3">
      <h3 id="agents-vm-title" className="label-hud text-fg">
        {t("agentVm.status.title")}
      </h3>
      <p
        role="status"
        data-vm={status.usable ? "usable" : "unusable"}
        className={status.usable ? "text-ui text-fg" : "text-ui text-attn"}
      >
        {status.usable ? t("agentVm.status.usable") : t("agentVm.unusable")}
      </p>
      {status.usable ? (
        <p className="text-ui text-muted">
          {[
            ...(status.vmdVersion === null
              ? []
              : [t("agentVm.status.version", { version: status.vmdVersion })]),
            t("agentVm.status.running", { n: running }),
          ].join(" · ")}
        </p>
      ) : status.reason === null ? null : (
        <p className="text-ui text-muted">
          {t("agentVm.status.reason", { reason: stripHidden(status.reason) })}
        </p>
      )}
      <div>
        <Button onClick={reload}>{t("agentVm.status.recheck")}</Button>
      </div>
    </section>
  );
}
