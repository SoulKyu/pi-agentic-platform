import { Button, Checkbox, InlineError } from "@pap/ui";
import { useState } from "react";
import { useT } from "../../../i18n/index.ts";
import { stripHidden } from "../../../lib/untrusted-text.ts";
import { codeText, failureCode } from "../failure.ts";
import type { StepUpRunner } from "../step-up.ts";
import { providerRpc } from "./provider-rpc.ts";

/**
 * Removes the provider's entry from `models.json` after a confirmation naming it. The stored key goes only when the
 * owner ticks the box (MPR14). The revision is the one the form read; a conflict reads it again and asks once more.
 * Works for a provider the form cannot edit (MPR8).
 */
export function RemoveProvider({
  id,
  name,
  revision,
  stepUp,
  reloadRevision,
  disabled,
  onRemoved,
  onOrphanKey,
}: {
  readonly id: string;
  readonly name: string;
  readonly revision: string;
  readonly stepUp: StepUpRunner;
  /** `models.provider.get` again: the failure code (or null) and whether the entry is no longer in the file. */
  reloadRevision(): Promise<{ readonly code: string | null; readonly gone: boolean }>;
  /** A save is running: nothing is removed meanwhile. */
  readonly disabled: boolean;
  onRemoved(id: string): void;
  /** The entry is gone but its stored key was asked for and may remain (MPR-C5). */
  onOrphanKey(id: string): void;
}) {
  const t = useT();
  const [asking, setAsking] = useState(false);
  const [alsoRemoveKey, setAlsoRemoveKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const remove = () => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    setFailed(null);
    stepUp((commandId) =>
      providerRpc().call(
        "models.provider.remove",
        { id, baseRevision: revision, alsoRemoveKey },
        { commandId },
      ),
    )
      .then(
        async (result) => {
          if (result === null) return;
          if ("code" in result) {
            setNotice(
              result.issues.includes("$.file")
                ? t("settingsProviders.notEditable.needs_raw_editor")
                : t("settingsProviders.issue.other"),
            );
            return;
          }
          onRemoved(id);
        },
        async (error: unknown) => {
          const code = failureCode(error);
          // The daemon removes the entry, then the key: a failure may leave the key behind with no entry to remove.
          const reloaded = code === "conflict" || alsoRemoveKey ? await reloadRevision() : null;
          if (reloaded?.gone === true && alsoRemoveKey) onOrphanKey(id);
          if (code !== "conflict") {
            setFailed(code);
            return;
          }
          setNotice(t("settingsProviders.remove.conflict"));
          if (reloaded?.code) setFailed(reloaded.code);
        },
      )
      .catch((error: unknown) => setFailed(failureCode(error)))
      .finally(() => setBusy(false));
  };

  return (
    <div data-remove-provider={id} className="flex flex-col items-start gap-s2">
      {asking ? (
        <div role="group" aria-label={t("settingsProviders.remove.button")} className="flex flex-col gap-s2">
          <p className="text-ui text-fg">
            {t("settingsProviders.remove.ask", { name: stripHidden(name || id) })}
          </p>
          <Checkbox
            label={t("settingsProviders.remove.key")}
            checked={alsoRemoveKey}
            disabled={busy}
            onChange={setAlsoRemoveKey}
          />
          <div className="flex gap-s2">
            <Button variant="primary" disabled={busy || disabled} onClick={remove}>
              {t("settingsProviders.remove.confirm")}
            </Button>
            <Button disabled={busy} onClick={() => setAsking(false)}>
              {t("settingsProviders.remove.keep")}
            </Button>
          </div>
        </div>
      ) : (
        <Button disabled={disabled} onClick={() => setAsking(true)}>
          {t("settingsProviders.remove.button")}
        </Button>
      )}
      {notice ? <InlineError announce="action">{notice}</InlineError> : null}
      {failed ? <InlineError announce="action">{codeText(failed)}</InlineError> : null}
    </div>
  );
}
