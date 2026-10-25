import "./register-space-catalog.ts";
import { AGENT_EVENT_LIMITS } from "@pap/contracts";
import { Button, InlineError, TextField, toast, usePendingAction } from "@pap/ui";
import { Dialog } from "@pap/ui/overlays";
import { useState } from "react";
import { errorKey, useT } from "../../i18n/index.ts";
import { getRuntime, RpcError } from "../../runtime/index.ts";

const MAX = AGENT_EVENT_LIMITS.queuePrompt;
/** The counter shows from half the limit. */
const COUNTER_FROM = MAX / 2 + 1;
const grouped = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");

/**
 * "Queue task" (M11R124): a prompt for this agent's own thread, run in its turn. A paused agent queues it and runs it
 * when resumed (the dialog says so). The prompt is the owner's, so it is sent as typed.
 */
export function QueueTaskDialog({
  agentId,
  agentName,
  paused,
  onClose,
}: {
  readonly agentId: string;
  readonly agentName: string;
  readonly paused: boolean;
  onClose(): void;
}) {
  const t = useT();
  const [prompt, setPrompt] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const queue = usePendingAction();
  const queued = t(paused ? "agentCompose.handOff.queuedPaused" : "agentCompose.handOff.queued", {
    name: agentName,
  });
  const submit = () =>
    void queue.run(async () => {
      setProblem(null);
      const { rpc } = getRuntime();
      try {
        await rpc.call("agents.queueTask", { agentId, prompt }, { commandId: rpc.newCommandId() });
        toast({ message: queued });
        onClose();
      } catch (failure) {
        setProblem(t(errorKey(failure instanceof RpcError ? failure.code : "internal")));
      }
    });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("agentCompose.queue.title", { name: agentName })}
      description={t("agentCompose.queue.description", { name: agentName })}
      closeLabel={t("agentCompose.queue.close")}
    >
      <form
        className="flex flex-col gap-s3"
        onSubmit={(event) => {
          event.preventDefault();
          if (prompt.trim() !== "") submit();
        }}
      >
        {paused ? (
          <p role="status" className="text-ui text-muted">
            {t("agentCompose.queue.paused", { name: agentName })}
          </p>
        ) : null}
        <TextField
          label={t("agentCompose.queue.prompt")}
          multiline
          rows={6}
          value={prompt}
          onChange={(value) => setPrompt(value.slice(0, MAX))}
          {...(prompt.length >= COUNTER_FROM
            ? { hint: t("agentCompose.queue.counter", { n: grouped(prompt.length), max: grouped(MAX) }) }
            : {})}
        />
        {problem === null ? null : <InlineError announce="action">{problem}</InlineError>}
        <div className="flex flex-wrap gap-s2">
          <Button type="submit" variant="primary" pendingSince={queue.since} disabled={prompt.trim() === ""}>
            {t("agentCompose.queue.submit")}
          </Button>
          <Button onClick={onClose}>{t("agentCompose.queue.cancel")}</Button>
        </div>
      </form>
    </Dialog>
  );
}
