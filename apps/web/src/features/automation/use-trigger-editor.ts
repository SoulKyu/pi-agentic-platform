import { TriggerView } from "@pap/contracts";
import { usePendingAction } from "@pap/ui";
import { useMemo, useState } from "react";
import { errorKey, useT } from "../../i18n/index.ts";
import { useStepUpRunner } from "../../lib/step-up-context.tsx";
import { getRuntime, RpcError } from "../../runtime/index.ts";
import { fireNowEnabled, isDirty, shownErrors, toInput, type Draft } from "./editor.vm.ts";

export interface EditorStatus {
  readonly tone: "ok" | "err";
  readonly text: string;
}

/**
 * The state behind the trigger editor: the draft, the saved trigger, and the three calls (save, fire, rotate). Save and
 * rotate go through the shell's password step-up; none is sent again after an unknown outcome (R105). The secret a create or
 * a rotation returns lives here only until the dialog that shows it closes.
 */
export function useTriggerEditor(initial: {
  readonly view: TriggerView | null;
  readonly draft: Draft;
  onCreated?(id: string): void;
}) {
  const t = useT();
  const stepUp = useStepUpRunner();
  const pending = usePendingAction();
  const [draft, setDraft] = useState(initial.draft);
  const [baseline, setBaseline] = useState(initial.draft);
  const [saved, setSaved] = useState(initial.view);
  const [attempted, setAttempted] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);
  const [status, setStatus] = useState<EditorStatus | null>(null);
  const [fires, setFires] = useState(0);

  const input = useMemo(() => toInput(draft), [draft]);
  const errors = input.ok ? {} : shownErrors(input.errors, draft, attempted);
  const rpc = () => getRuntime().rpc;

  const failure = (cause: unknown): EditorStatus => {
    const code = cause instanceof RpcError ? cause.code : "internal";
    return {
      tone: "err",
      text: t(code === "conflict" ? "automation.editor.error.conflict" : errorKey(code)),
    };
  };

  const save = () =>
    void pending.run(async () => {
      setAttempted(true);
      const result = toInput(draft);
      if (!result.ok) {
        setStatus({ tone: "err", text: t("automation.editor.fix") });
        return;
      }
      setStatus(null);
      try {
        const answer = await stepUp((commandId) =>
          saved === null
            ? rpc().call("automation.triggers.create", { input: result.input }, { commandId })
            : rpc().call(
                "automation.triggers.update",
                { triggerId: saved.id, baseRevision: saved.revision, input: result.input },
                { commandId },
              ),
        );
        if (answer === null) return;
        // The secret is shown once: it is kept before anything that can still fail.
        setSecret(answer.secret);
        const view = TriggerView.parse(answer.trigger);
        setSaved(view);
        setBaseline(draft);
        if (saved === null) {
          // The tab is swapped once the secret dialog is closed: the swap remounts the pane and the secret would be lost.
          if (answer.secret === null) initial.onCreated?.(view.id);
          else setCreated(view.id);
        }
        setStatus({ tone: "ok", text: t("automation.editor.saved") });
      } catch (cause) {
        setStatus(failure(cause));
      }
    });

  const fire = () =>
    void pending.run(async () => {
      if (saved === null) return;
      setStatus(null);
      try {
        const answer = await rpc().call(
          "automation.fire",
          { triggerId: saved.id },
          { commandId: rpc().newCommandId() },
        );
        setFires((count) => count + 1);
        setStatus(
          answer.verdict === "fired"
            ? { tone: "ok", text: t("automation.editor.fired") }
            : {
                tone: "err",
                text: t(
                  answer.verdict === "precheck"
                    ? "automation.editor.fireSkipped"
                    : "automation.editor.fireFailed",
                ),
              },
        );
      } catch (cause) {
        setStatus(failure(cause));
      }
    });

  const rotate = () => {
    setRotating(false);
    if (saved === null) return;
    const triggerId = saved.id;
    void pending.run(async () => {
      setStatus(null);
      try {
        const answer = await stepUp((commandId) =>
          rpc().call("automation.triggers.rotateSecret", { triggerId }, { commandId }),
        );
        if (answer !== null) setSecret(answer.secret);
      } catch (cause) {
        setStatus(failure(cause));
      }
    });
  };

  return {
    draft,
    set: (patch: Partial<Draft>) => {
      setDraft((previous) => ({ ...previous, ...patch }));
      setStatus(null);
    },
    input,
    errors,
    attempted: () => setAttempted(true),
    saved,
    status,
    since: pending.since,
    canFire: fireNowEnabled(draft, baseline, saved?.id ?? null),
    dirty: isDirty(draft, baseline),
    canRotate: saved !== null && saved.source?.type === "webhook" && draft.sourceType === "webhook",
    fires,
    secret,
    closeSecret: () => {
      setSecret(null);
      if (created !== null) {
        setCreated(null);
        initial.onCreated?.(created);
      }
    },
    rotating,
    askRotate: () => setRotating(true),
    cancelRotate: () => setRotating(false),
    save,
    fire,
    rotate,
  };
}
