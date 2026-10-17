import type { SandboxStatus } from "@pap/contracts";
import { useT } from "../../i18n/index.ts";

/** The probe's one line (M11R93): where bubblewrap is, or why it cannot be used, or that the check has not answered. */
export function SandboxLine({ probe }: { readonly probe: SandboxStatus }) {
  const t = useT();
  const checking = probe.checkedAt === 0;
  const line = checking
    ? t("agentForm.probe.checking")
    : probe.usable
      ? t("agentForm.probe.usable", { path: probe.path ?? "" })
      : t("agentForm.probe.unusable", { reason: t(`agentForm.probe.reason.${probe.reason ?? "missing"}`) });
  return (
    <p
      role="status"
      data-probe={checking ? "checking" : probe.usable ? "usable" : "unusable"}
      className={probe.checkedAt !== 0 && !probe.usable ? "text-ui text-attn" : "text-ui text-muted"}
    >
      {line}
    </p>
  );
}

/** The egress proxy's own needs (M11R245): shown where a network switch is, once the probe has answered. */
export function EgressLine({ probe }: { readonly probe: SandboxStatus }) {
  const t = useT();
  const { egress } = probe;
  if (probe.checkedAt === 0 || egress === undefined || egress.usable) return null;
  const reason = t(`agentForm.egress.reason.${egress.reason ?? "no_python"}`);
  return (
    <p role="status" data-slot="egress-line" className="text-ui text-attn">
      {t("agentForm.egress.unusable", { reason })}
    </p>
  );
}
