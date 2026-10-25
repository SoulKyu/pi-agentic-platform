import "./register-lanes-catalog.ts";
import type { LaneView } from "@pap/contracts";
import { Button, Checkbox, InlineError } from "@pap/ui";
import { Dialog } from "@pap/ui/overlays";
import { Fragment, useRef, useState } from "react";
import { useT, type MessageKey } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { useLaneShipStore } from "../../stores/lane-ship-store.ts";
import { failureKey } from "./failure-text.ts";
import { visibleLog } from "./log-text.ts";
import { TaintedConfirm } from "./TaintedConfirm.tsx";

type Refusal = "busy" | "dirty" | "script_failed" | "setup_running" | "tainted";

interface Props {
  readonly lane: Pick<LaneView, "id" | "branch">;
  /** Called when the dialog closes, archived or not. */
  onClose(): void;
  /** The clock of the confirmation guard; tests give their own. */
  readonly now?: () => number;
}

/** A press on the confirmation within this time of its appearing is a double-click or a held key, not a decision. */
export const CONFIRM_GUARD_MS = 500;

/**
 * The archive confirmation (M9R66). Archiving removes the worktree: Force also loses its uncommitted changes, so it is
 * the danger path and asks once more, in words that name the loss. Mounted only while open; Radix traps focus and
 * returns it to the opener.
 */
export function ArchiveDialog({ lane, onClose, now }: Props) {
  const t = useT();
  const [force, setForce] = useState(false);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<{ reason: Refusal; logTail: string | null } | null>(null);
  const [kept, setKept] = useState(false);
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const askedAt = useRef(0);

  // Promise chains, not try/finally: the React Compiler bails out on a finalizer.
  const send = (confirmTainted: boolean) => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    setAsking(false);
    const { rpc } = getRuntime();
    rpc
      .call(
        "lanes.archive",
        { laneId: lane.id, force, deleteBranch, ...(confirmTainted ? { confirmTainted: true } : {}) },
        { commandId: rpc.newCommandId() },
      )
      .then(
        (answer) => {
          setBusy(false);
          if (answer.ok && answer.branchDeleted === false) {
            // The archived lane leaves the store before this answer: the dialog may already be gone.
            useLaneShipStore.getState().patch(lane.id, { keptBranch: lane.branch });
            setKept(true);
          } else if (answer.ok) onClose();
          else setRefusal({ reason: answer.reason, logTail: answer.logTail });
        },
        (failure: unknown) => {
          setBusy(false);
          setRefusal(null);
          setProblem(failureKey(failure, "lanes.archive.failed"));
        },
      );
  };
  const archive = () => {
    setRefusal(null);
    if (force) {
      askedAt.current = (now ?? Date.now)();
      setAsking(true);
    } else send(false);
  };
  const confirmLoss = () => {
    if ((now ?? Date.now)() - askedAt.current < CONFIRM_GUARD_MS) return;
    send(false);
  };

  // The options are fixed while a question about them is open: a tick after the refusal must not change what is sent.
  const locked = busy || asking || kept || refusal?.reason === "tainted";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={t("lanes.archive.title")}
      description={t("lanes.archive.description", { branch: lane.branch })}
      closeLabel={t("lanes.action.close")}
      footer={
        kept ? (
          <Button key="done" variant="primary" onClick={onClose}>
            {t("lanes.archive.done")}
          </Button>
        ) : asking ? (
          <Fragment key="confirm">
            <Button disabled={busy} onClick={() => setAsking(false)}>
              {t("lanes.archive.back")}
            </Button>
            <Button variant="danger" disabled={busy} onClick={confirmLoss}>
              {t("lanes.archive.confirmForceRun")}
            </Button>
          </Fragment>
        ) : (
          <Fragment key="choose">
            <Button disabled={busy} onClick={onClose}>
              {t("lanes.action.cancel")}
            </Button>
            <Button
              variant={force ? "danger" : "primary"}
              disabled={busy || refusal?.reason === "tainted"}
              onClick={archive}
            >
              {t("lanes.action.archive")}
            </Button>
          </Fragment>
        )
      }
    >
      <div className="flex flex-col gap-s3 p-s3">
        <Checkbox label={t("lanes.archive.force")} checked={force} disabled={locked} onChange={setForce} />
        {force ? <p className="text-ui text-attn">{t("lanes.archive.forceLoses")}</p> : null}
        <Checkbox
          label={t("lanes.archive.deleteBranch", { branch: lane.branch })}
          checked={deleteBranch}
          disabled={locked}
          onChange={setDeleteBranch}
        />
        <p className="text-ui text-muted">{t("lanes.archive.deleteBranch.note")}</p>
        {kept ? (
          <p role="status" className="text-ui text-attn">
            {t("lanes.archive.branchKept", { branch: lane.branch })}
          </p>
        ) : null}
        {asking ? (
          <InlineError tone="attn" announce="action">
            {t("lanes.archive.confirmForce")}
          </InlineError>
        ) : null}
        {refusal !== null && refusal.reason !== "tainted" ? (
          <div className="flex flex-col gap-s1">
            <InlineError announce="action">{t(`lanes.archive.refused.${refusal.reason}`)}</InlineError>
            {refusal.reason === "script_failed" && refusal.logTail !== null ? (
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-code text-fg">
                {visibleLog(refusal.logTail)}
              </pre>
            ) : null}
          </div>
        ) : null}
        {refusal?.reason === "tainted" ? (
          <TaintedConfirm busy={busy} onConfirm={() => send(true)} onCancel={() => setRefusal(null)} />
        ) : null}
        {problem !== null ? <InlineError announce="action">{t(problem)}</InlineError> : null}
      </div>
    </Dialog>
  );
}
