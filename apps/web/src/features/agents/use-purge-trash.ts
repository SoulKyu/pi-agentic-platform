import "./register-agent-catalog.ts";
import { toast } from "@pap/ui";
import { errorKey, useT } from "../../i18n/index.ts";
import { useStepUpRunner } from "../../lib/step-up-context.tsx";
import { getRuntime, RpcError } from "../../runtime/index.ts";

/**
 * "Purge now" for a deleted VM agent's trash (RT-40): `agents.purgeTrash` through the password step-up, then a note. Resolves
 * true once the trash was emptied; false when the prompt was cancelled or the daemon refused (the refusal is a note).
 */
export function usePurgeTrash(): (agentId: string, name: string) => Promise<boolean> {
  const t = useT();
  const stepUp = useStepUpRunner();
  return (agentId, name) =>
    stepUp((commandId) => getRuntime().rpc.call("agents.purgeTrash", { agentId }, { commandId })).then(
      (purged) => {
        if (purged !== null) toast({ message: t("agentVm.purged", { name }) });
        return purged !== null;
      },
      (failure: unknown) => {
        toast({
          message: t(errorKey(failure instanceof RpcError ? failure.code : "internal")),
          tone: "error",
        });
        return false;
      },
    );
}
