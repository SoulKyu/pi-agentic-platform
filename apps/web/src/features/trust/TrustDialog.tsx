import "./register-dialog-catalog.ts";
import { Button, InlineError } from "@pap/ui";
import { Dialog } from "@pap/ui/overlays";
import { useState } from "react";
import { useT } from "../../i18n/index.ts";
import { escapeHidden } from "../../lib/escape-hidden.ts";
import { useStepUpRunner } from "../../lib/step-up-context.tsx";
import { TrustResources } from "./TrustResources.tsx";
import { incompleteness } from "./trust.vm.ts";
import { sendDecision } from "./send-decision.ts";
import { useTrustStatus } from "./use-trust-status.ts";

function Current({
  status,
}: {
  readonly status: { decision: boolean | null; inherited: boolean; decisionPath: string | null };
}) {
  const t = useT();
  const key =
    status.decision === null
      ? "trust.current.none"
      : status.decision
        ? "trust.current.trusted"
        : "trust.current.untrusted";
  return (
    <p className="text-ui text-muted">
      {t(key)}
      {status.inherited && status.decisionPath !== null
        ? ` ${t("trust.current.inherited", { path: escapeHidden(status.decisionPath) })}`
        : ""}
    </p>
  );
}

/**
 * The trust decision for a folder (M7R109), mounted only while open. Trusting runs the folder's code later, so it goes
 * through the host's password prompt; keeping it untrusted only narrows and does not (MC47). A breach of the breadth
 * rule is an answer of the call, shown in plain words; the decision applies when Pi restarts for the session (M7R105).
 */
export function TrustDialog({
  cwd,
  onDecided,
  onClose,
}: {
  readonly cwd: string;
  onDecided(trusted: boolean): void;
  onClose(): void;
}) {
  const t = useT();
  const stepUp = useStepUpRunner();
  const { status, error, retry } = useTrustStatus(cwd);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const decide = async (decision: boolean) => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const outcome = await sendDecision(cwd, decision, stepUp);
    setBusy(false);
    if (outcome.applied) onDecided(decision);
    else {
      setProblem(outcome.problem);
      // The write may have landed (R105): the list is the truth, so the decision shown is read again.
      if (outcome.unknown) retry();
    }
  };

  const gaps = status === null ? null : incompleteness(status);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // Esc, the backdrop and the close button wait for the answer of a decision in flight (MC49 M3).
        if (!open && !busy) onClose();
      }}
      title={t("trust.dialog.title")}
      description={t("trust.dialog.description")}
      closeLabel={t("trust.dialog.close")}
    >
      <div className="flex flex-col gap-s3 p-s3">
        <p className="break-all text-ui text-muted">{t("trust.folder", { path: escapeHidden(cwd) })}</p>
        {error !== null ? (
          <div className="flex flex-col items-start gap-s2">
            <InlineError announce="background">{error}</InlineError>
            <Button onClick={retry}>{t("trust.retry")}</Button>
          </div>
        ) : status === null ? (
          <p role="status" className="text-ui text-muted">
            {t("trust.loading")}
          </p>
        ) : (
          <>
            <Current status={status} />
            <TrustResources status={status} />
            {gaps?.incomplete ? (
              <div role="status" className="flex flex-col gap-s1 border-l-2 border-attn pl-s2">
                <p className="text-ui font-semibold text-attn">{t("trust.incomplete.title")}</p>
                <p className="text-ui text-muted">{t("trust.incomplete.body")}</p>
                {status.resources.truncated ? (
                  <p className="text-ui text-muted">{t("trust.incomplete.cut")}</p>
                ) : null}
                <ul className="flex flex-col">
                  {gaps.reasons.map((reason, index) => (
                    <li key={`${index}:${reason}`} className="break-all text-ui text-fg">
                      {reason}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        )}
        <p className="text-ui text-muted">{t("trust.restart")}</p>
        {problem !== null ? <InlineError announce="action">{problem}</InlineError> : null}
        <div className="flex flex-wrap justify-end gap-s2">
          <Button disabled={busy} onClick={onClose}>
            {t("trust.action.cancel")}
          </Button>
          <Button disabled={busy || status === null} onClick={() => void decide(false)}>
            {t("trust.action.keep")}
          </Button>
          <Button variant="primary" disabled={busy || status === null} onClick={() => void decide(true)}>
            {t("trust.action.trust")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
