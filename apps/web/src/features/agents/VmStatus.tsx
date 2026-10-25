import "./register-agent-catalog.ts";
import type { VmStatusView } from "@pap/contracts";
import { Button, Heading, InlineError } from "@pap/ui";
import { vmPhaseLifecycle, type Lifecycle } from "./agent-lifecycle.ts";
import { useT } from "../../i18n/index.ts";
import { stripHidden } from "../../lib/untrusted-text.ts";

/**
 * Settings › Agents › Agent VMs, in place of the sandbox when agents run in VMs: whether they can start and, when they
 * cannot, what to run (R6) and the daemon's reason. Same layout as `SandboxStatus` (no board of its own). The reason is
 * the daemon's text: drawn as text, hidden characters removed.
 */
export function VmStatus({ status, reload }: { readonly status: VmStatusView; reload(): void }) {
  const t = useT();
  const count = (word: Lifecycle | "running") =>
    status.agents.filter(
      (agent) => (agent.phase === "running" ? "running" : vmPhaseLifecycle(agent.phase)) === word,
    ).length;
  const words = [
    t("agentVm.status.running", { n: count("running") }),
    ...(["waking", "parked", "paused"] as const).flatMap((word) =>
      count(word) === 0 ? [] : [`${count(word)} ${t(`shell.agent.state.${word}`)}`],
    ),
  ];
  return (
    <section data-slot="agents-vm" aria-labelledby="agents-vm-title" className="flex flex-col gap-s3">
      <Heading level={2} variant="group" id="agents-vm-title">
        {t("agentVm.status.title")}
      </Heading>
      {status.usable ? (
        <p role="status" data-vm="usable" className="text-ui text-fg">
          {t("agentVm.status.usable")}
        </p>
      ) : (
        <div data-vm="unusable">
          <InlineError announce="background">{t("agentVm.unusable")}</InlineError>
        </div>
      )}
      {status.usable ? (
        <p className="text-ui text-muted">
          {[
            ...(status.vmdVersion === null
              ? []
              : [t("agentVm.status.version", { version: status.vmdVersion })]),
            ...words,
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
