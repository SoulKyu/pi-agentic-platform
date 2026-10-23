import "./register-agent-catalog.ts";
import "./register-space-catalog.ts";
import { Button, toast, usePendingAction } from "@pap/ui";
import { Dialog } from "@pap/ui/overlays";
import { useState } from "react";
import { errorKey, type MessageKey, useT } from "../../i18n/index.ts";
import { useStepUpRunner } from "../../lib/step-up-context.tsx";
import { usePurgeTrash } from "./use-purge-trash.ts";
import { getRuntime, RpcError } from "../../runtime/index.ts";

export interface DeleteAgentDialogProps {
  readonly agent: { readonly id: string; readonly name: string };
  onClose(): void;
}

const refusal = (failure: unknown): MessageKey => {
  const code = failure instanceof RpcError ? failure.code : "internal";
  return code === "command_failed" ? "agentSafety.d.partial" : errorKey(code);
};

/**
 * Delete an agent (M11R126): what goes where, then the owner's password (`agents.delete` always asks). The home and its
 * tasks' scratch folders go to .trash; its triggers and secrets are deleted. A half-done delete leaves the agent quarantined
 * and asking again finishes it.
 */
export function DeleteAgentDialog({ agent, onClose }: DeleteAgentDialogProps) {
  const t = useT();
  const stepUp = useStepUpRunner();
  const pending = usePendingAction();
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const name = agent.name;

  const purgeTrash = usePurgeTrash();
  const purge = () => void purgeTrash(agent.id, name);

  const remove = () =>
    void pending.run(async () => {
      setProblem(null);
      const { rpc } = getRuntime();
      let done = false;
      let failed: MessageKey | null = null;
      try {
        done =
          (await stepUp((commandId) => rpc.call("agents.delete", { agentId: agent.id }, { commandId }))) !==
          null;
      } catch (failure) {
        failed = refusal(failure);
      }
      setProblem(failed);
      if (done) {
        // An agent's trash is kept 7 days (RT-40): the note offers to empty it now.
        toast({
          message: t("agentSafety.d.done", { name }),
          action: { label: t("agentVm.purge"), altText: t("agentVm.purge.altText"), run: purge },
        });
        onClose();
      }
    });

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t("agentSafety.d.title", { name })}
      description={t("agentSafety.d.body")}
      closeLabel={t("ui.close")}
      footer={
        <>
          <Button onClick={onClose}>{t("agentSafety.d.cancel")}</Button>
          <Button variant="primary" pendingSince={pending.since} onClick={remove}>
            {t("agentSafety.d.confirm", { name })}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-s2 p-s3">
        {problem !== null ? (
          <p role="alert" className="text-ui text-attn">
            {t(problem, { name })}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
