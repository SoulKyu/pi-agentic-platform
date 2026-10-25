import "./register-space-catalog.ts";
import { QuarantineResult } from "@pap/contracts";
import { Button, Heading, InlineError, usePendingAction } from "@pap/ui";
import { Dialog } from "@pap/ui/overlays";
import { useState } from "react";
import { errorKey, type MessageKey, useT } from "../../i18n/index.ts";
import { useStepUpRunner } from "../../lib/step-up-context.tsx";
import { getRuntime, RpcError } from "../../runtime/index.ts";
import { SecretReveal } from "./SecretReveal.tsx";

export interface QuarantineDialogProps {
  readonly agent: { readonly id: string; readonly name: string };
  onClose(): void;
}

const STEPS = ["pause", "tasks", "thread", "rotate", "vault", "files"] as const;
const refusal = (failure: unknown): MessageKey =>
  failure instanceof RpcError && failure.code === "conflict"
    ? "agentSafety.q.replay"
    : errorKey(failure instanceof RpcError ? failure.code : "internal");
/** A step's reason in pap's words: the daemon sends `timeout`, `failed` or a PapError code, never error text. */
const reasonKey = (code: string): MessageKey =>
  code === "timeout"
    ? "agentSafety.q.reason.timeout"
    : code === "failed"
      ? "agentSafety.q.reason.failed"
      : errorKey(code);

/**
 * Quarantine (M11R115, M11R126): two confirmations, then the owner's password, then the answer. The rotated webhook secrets
 * are in the answer once; they live in this dialog's state alone and are gone when it closes (no store, URL, toast or log).
 * A replay of the command answers `conflict`: it says the quarantine already ran.
 */
export function QuarantineDialog({ agent, onClose }: QuarantineDialogProps) {
  const t = useT();
  const stepUp = useStepUpRunner();
  const pending = usePendingAction();
  const [second, setSecond] = useState(false);
  const [result, setResult] = useState<QuarantineResult | null>(null);
  const [problem, setProblem] = useState<MessageKey | null>(null);

  const quarantine = () =>
    void pending.run(async () => {
      setProblem(null);
      const { rpc } = getRuntime();
      let raw: unknown = null;
      let failed: MessageKey | null = null;
      try {
        raw = await stepUp((commandId) =>
          rpc.call("agents.quarantine", { agentId: agent.id }, { commandId }),
        );
      } catch (failure) {
        failed = refusal(failure);
      }
      // The call went through; an answer that does not parse is not a failure to quarantine (m3).
      const parsed = raw === null ? null : QuarantineResult.safeParse(raw);
      setResult(parsed?.success === true ? parsed.data : null);
      setProblem(parsed?.success === false ? "agentSafety.q.unreadable" : failed);
    });

  const name = agent.name;
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        // The answer holds secrets shown once: it cannot be closed away while the call runs.
        if (!next && pending.since === null) onClose();
      }}
      title={t(result === null ? "agentSafety.q.title" : "agentSafety.q.doneTitle", { name })}
      closeLabel={t("ui.close")}
      footer={
        result !== null ? (
          <Button variant="primary" onClick={onClose}>
            {t("agentSafety.q.done")}
          </Button>
        ) : (
          <>
            <Button disabled={pending.since !== null} onClick={onClose}>
              {t("agentSafety.q.cancel")}
            </Button>
            {second ? (
              <Button variant="primary" pendingSince={pending.since} onClick={quarantine}>
                {t("agentSafety.q.confirm", { name })}
              </Button>
            ) : (
              <Button variant="primary" onClick={() => setSecond(true)}>
                {t("agentSafety.q.continue")}
              </Button>
            )}
          </>
        )
      }
    >
      <div className="flex flex-col gap-s3 p-s3">
        {result !== null ? (
          <Outcome result={result} />
        ) : second ? (
          <p className="text-ui text-fg">{t("agentSafety.q.second", { name })}</p>
        ) : (
          <>
            <p className="text-ui text-fg">{t("agentSafety.q.intro")}</p>
            <ul className="list-disc pl-s4 text-ui text-fg">
              {STEPS.map((step) => (
                <li key={step}>{t(`agentSafety.q.step.${step}`)}</li>
              ))}
            </ul>
          </>
        )}
        {problem !== null ? <InlineError announce="action">{t(problem)}</InlineError> : null}
      </div>
    </Dialog>
  );
}

function Outcome({ result }: { readonly result: QuarantineResult }) {
  const t = useT();
  return (
    <>
      {result.secrets.length === 0 ? null : (
        <div className="flex flex-col gap-s2">
          <Heading level={3} variant="card">
            {t("agentSafety.q.secrets")}
          </Heading>
          <p className="text-ui text-attn">{t("agentSafety.q.secrets.note")}</p>
          {result.secrets.map((one) => (
            <SecretReveal key={one.triggerId} name={one.name} secret={one.secret} />
          ))}
        </div>
      )}
      {result.vaultNames.length === 0 ? null : (
        <p className="text-ui text-fg">{t("agentSafety.q.vault", { names: result.vaultNames.join(", ") })}</p>
      )}
      {result.filePaths === undefined || result.filePaths.length === 0 ? null : (
        <p className="text-ui text-fg">{t("agentSafety.q.files", { paths: result.filePaths.join(", ") })}</p>
      )}
      <p className="text-ui text-muted">{t("agentSafety.q.tasks", { n: result.tasksCancelled })}</p>
      {result.errors.length === 0 ? null : (
        <div className="flex flex-col gap-s1">
          <InlineError announce="action">{t("agentSafety.q.errors")}</InlineError>
          <ul className="list-disc pl-s4 text-ui text-fg">
            {result.errors.map((one, index) => (
              <li key={`${index}:${one.step}`}>
                {t("agentSafety.q.error", {
                  step: t(`agentSafety.q.errorStep.${one.step}`),
                  reason: t(reasonKey(one.code)),
                })}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
