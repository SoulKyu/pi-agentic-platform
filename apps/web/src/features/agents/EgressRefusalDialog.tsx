import "./register-space-catalog.ts";
import {
  AGENT_LIMITS,
  type AgentInput,
  type EgressRefusedCardData,
  entryFor,
  widensReach,
} from "@pap/contracts";
import { Button, toast, usePendingAction } from "@pap/ui";
import { Dialog } from "@pap/ui/overlays";
import { useState } from "react";
import { errorKey, type MessageKey, useLocale, useT } from "../../i18n/index.ts";
import { useStepUpRunner } from "../../lib/step-up-context.tsx";
import { getRuntime, RpcError } from "../../runtime/index.ts";
import { useAgentView } from "./use-agent-view.ts";
import { useOwnerHosts } from "./use-owner-hosts.ts";

export interface EgressRefusalDialogProps {
  readonly agent: { readonly id: string; readonly name: string };
  readonly data: EgressRefusedCardData;
  onClose(): void;
}

/**
 * The list after the add: the agent's own list plus the entry, or, for an agent on the owner's list (`allowHosts: null`), a
 * copy of the owner's list plus the entry. The owner's list and the other agents stay as they are.
 */
export function listWith(
  own: readonly string[] | null,
  ownerHosts: readonly string[] | null,
  entry: string,
): string[] {
  const list = own ?? ownerHosts ?? [];
  return list.includes(entry) ? [...list] : [...list, entry];
}

const failure = (cause: unknown): MessageKey => {
  const code = cause instanceof RpcError ? cause.code : "internal";
  return code === "conflict" ? "agentEgress.d.conflict" : errorKey(code);
};

/**
 * Add a refused host to the agent's list (spec §6): the host and port, the attempts, the address when it is private, and the
 * scope. Adding widens the agent's reach, so it takes the same step-up the agent form asks. Close writes nothing.
 */
export function EgressRefusalDialog({ agent, data, onClose }: EgressRefusalDialogProps) {
  const t = useT();
  const locale = useLocale();
  const stepUp = useStepUpRunner();
  const pending = usePendingAction();
  const { load } = useAgentView(agent.id, "egress-refusal");
  const ownerHosts = useOwnerHosts();
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const target = `${data.host}:${data.port}`;
  const view = load.kind === "ready" ? load.agent : null;
  const before: AgentInput | null = view?.input ?? null;
  const usesOwnerList = before !== null && before.allowHosts === null;
  const known = before !== null && (!usesOwnerList || ownerHosts !== undefined);
  const entry = entryFor(data.host, data.port);
  // M2: the list after the add, checked before the owner's list is copied or the entry appended.
  const list = known ? listWith(before.allowHosts, ownerHosts ?? null, entry) : null;
  const full = list !== null && list.length > AGENT_LIMITS.hosts;
  const ready = known && !full;
  const time = new Intl.DateTimeFormat(locale, {
    // M5: a card from another day names the day.
    ...(new Date(data.lastAt).toDateString() === new Date().toDateString()
      ? {}
      : { day: "numeric", month: "short" }),
    hour: "2-digit",
    minute: "2-digit",
  }).format(data.lastAt);
  const vm =
    data.source === "thread"
      ? t("agentEgress.d.vm.thread")
      : t("agentEgress.d.vm.task", { task: data.source });

  const add = () =>
    void pending.run(async () => {
      if (view === null || before === null || list === null || full) return;
      setProblem(null);
      const input = {
        ...before,
        allowHosts: list ?? [],
      };
      const { rpc } = getRuntime();
      const run = (commandId: string) =>
        rpc.call("agents.update", { agentId: agent.id, baseRevision: view.revision, input }, { commandId });
      // The choice is made before the try: the React Compiler bails out on a conditional inside one.
      const send = widensReach(before, input, ownerHosts) ? () => stepUp(run) : () => run(rpc.newCommandId());
      try {
        if ((await send()) === null) return; // the password prompt was cancelled: a choice, not an error
      } catch (cause) {
        setProblem(failure(cause));
        return;
      }
      toast({ message: t("agentEgress.d.added", { host: data.host, port: data.port, name: agent.name }) });
      onClose();
    });

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t("agentEgress.d.title", { host: data.host, port: data.port })}
      description={t(`agentEgress.card.${data.reason}`, {
        name: agent.name,
        host: data.host,
        port: data.port,
      })}
      closeLabel={t("ui.close")}
      footer={
        <>
          <Button onClick={onClose}>{t("ui.close")}</Button>
          <Button variant="primary" disabled={!ready} pendingSince={pending.since} onClick={add}>
            {t("agentEgress.d.add")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-s2 p-s3">
        <dl className="flex flex-col gap-s1">
          <dt className="label-hud text-muted">{t("agentEgress.d.hostLabel")}</dt>
          <dd className="break-all font-mono text-code text-fg">{target}</dd>
          <dt className="label-hud text-muted">{t("agentEgress.d.attempts")}</dt>
          <dd className="text-ui text-fg">
            {t("agentEgress.d.attemptsLine", { count: data.count, time, vm })}
          </dd>
        </dl>
        {data.address === null ? null : (
          <p data-private-address="" className="text-ui text-attn">
            {t("agentEgress.d.private", { address: data.address })}
          </p>
        )}
        <p className="text-ui text-muted">{t("agentEgress.d.scope")}</p>
        {usesOwnerList ? (
          <p className="text-ui text-muted">{t("agentEgress.d.copy", { name: agent.name })}</p>
        ) : null}
        {full ? (
          <p role="alert" className="text-ui text-attn">
            {t("agentEgress.d.full", { name: agent.name, max: AGENT_LIMITS.hosts })}
          </p>
        ) : null}
        {problem !== null ? (
          <p role="alert" className="text-ui text-attn">
            {t(problem, { name: agent.name })}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
