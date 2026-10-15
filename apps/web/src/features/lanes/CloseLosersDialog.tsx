import "./register-compare-catalog.ts";
import type { ResultOf } from "@pap/contracts";
import { Button } from "@pap/ui";
import { Dialog } from "@pap/ui/overlays";
import { Fragment, useState } from "react";
import { type MessageKey, useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { CONFIRM_GUARD_MS } from "./ArchiveDialog.tsx";
import type { ColumnModel } from "./compare.vm.ts";
import { compareFailureKey } from "./use-compare.ts";
import { TaintedConfirm } from "./TaintedConfirm.tsx";

type Answer = ResultOf<"lanes.closeLosers">;

interface Props {
  readonly fanoutId: string;
  readonly winner: ColumnModel;
  readonly losers: readonly ColumnModel[];
  /** Called when the dialog closes, whether lanes were closed or not. */
  onClose(): void;
  /** The clock of the confirmation guard; tests give their own. */
  readonly now?: () => number;
}

/** What the owner loses, lane by lane: the daemon archives with force, so uncommitted files go (M9R86). */
const lossKey = (dirty: number | null): MessageKey =>
  dirty === null
    ? "compare.close.lane"
    : dirty === 0
      ? "compare.close.clean"
      : dirty === 1
        ? "compare.close.dirty.one"
        : "compare.close.dirty";

const nameOf = (model: ColumnModel): string => `${model.letter} · ${model.branch}`;

/**
 * Close losers (M9R96): archiving removes the other lanes' worktrees, so it names each lane and what goes before
 * anything is sent. There is no force switch: the daemon always discards uncommitted changes and keeps the branch and
 * its commits. A press within the guard of the dialog opening is a double-click, not a decision. A refusal for taint
 * asks inline and sends again with the owner's word; other refusals are listed and those lanes stay as they were.
 */
export function CloseLosersDialog({ fanoutId, winner, losers, onClose, now }: Props) {
  const t = useT();
  const [openedAt] = useState(() => (now ?? Date.now)());
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<MessageKey | null>(null);

  // Promise chains, not try/finally: the React Compiler bails out on a finalizer.
  const send = (confirmTainted: boolean) => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    setAsking(false);
    const { rpc } = getRuntime();
    rpc
      .call(
        "lanes.closeLosers",
        { fanoutId, winner: winner.laneId, ...(confirmTainted ? { confirmTainted: true } : {}) },
        { commandId: rpc.newCommandId() },
      )
      .then(
        (done) => {
          setBusy(false);
          if (done.refused.length === 0) onClose();
          else {
            setAnswer(done);
            setAsking(done.refused.some((one) => one.reason === "tainted"));
          }
        },
        (failure: unknown) => {
          setBusy(false);
          setProblem(compareFailureKey(failure));
        },
      );
  };
  const confirm = () => {
    if ((now ?? Date.now)() - openedAt < CONFIRM_GUARD_MS) return;
    send(false);
  };

  const byId = new Map(losers.map((loser) => [loser.laneId, loser]));
  const count = losers.length;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={t("compare.close.title")}
      description={t("compare.close.description", { winner: nameOf(winner) })}
      closeLabel={t("lanes.action.close")}
      footer={
        answer === null ? (
          <Fragment key="confirm">
            <Button disabled={busy} onClick={onClose}>
              {t("compare.close.back")}
            </Button>
            <Button variant="danger" disabled={busy || count === 0} onClick={confirm}>
              {count === 1 ? t("compare.close.one") : t("compare.close.other", { count })}
            </Button>
          </Fragment>
        ) : (
          <Fragment key="result">
            <Button variant="primary" disabled={busy} onClick={onClose}>
              {t("compare.close.done")}
            </Button>
          </Fragment>
        )
      }
    >
      <div className="flex flex-col gap-s3 p-s3">
        {answer === null ? (
          <ul className="flex flex-col gap-s2 text-ui text-fg">
            {losers.map((loser) => (
              <li key={loser.laneId}>
                {t(lossKey(loser.dirty), {
                  label: loser.letter,
                  branch: loser.branch,
                  count: loser.dirty ?? 0,
                })}
              </li>
            ))}
          </ul>
        ) : (
          <div role="alert" className="flex flex-col gap-s2 text-ui text-attn">
            <p>{t("compare.close.stays")}</p>
            <ul className="flex flex-col gap-s1">
              {answer.refused.map((one) => {
                const loser = byId.get(one.laneId);
                return (
                  <li key={one.laneId}>
                    {t(`compare.close.refused.${one.reason}`, {
                      lane: loser === undefined ? one.laneId : nameOf(loser),
                    })}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {asking ? (
          <TaintedConfirm busy={busy} onConfirm={() => send(true)} onCancel={() => setAsking(false)} />
        ) : null}
        {problem !== null ? (
          <p role="alert" className="text-ui text-attn">
            {t(problem)}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
