import "../../i18n/register-settings-providers.ts";
import type { ProviderView } from "@pap/contracts";
import { Button, InlineError, LoadingLine } from "@pap/ui";
import "../../i18n/register-launch.ts";
import { usePiCauseText } from "../../stores/loading-cause.ts";
import { useMemo, useState } from "react";
import { DiscardConfirm } from "./DiscardConfirm.tsx";
import { useLazyFailureText, useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { failureText } from "./failure.ts";
import { stripHidden } from "../../lib/untrusted-text.ts";
import { LazyPanel } from "../../lib/LazyPanel.tsx";
import type { ProviderFormHost } from "./use-provider-form-host.ts";
import type { StepUpRunner } from "./step-up.ts";

// One function for the life of the page: `useRetryableLazy` shares the lazy component by it.
const loadForm = () => import("./provider/index.ts").then((module) => ({ default: module.ProviderForm }));

/** The stored key of a provider that left the file while its removal failed: removed on request, or dismissed. */
export function OrphanKey({
  id,
  stepUp,
  onDone,
  onChanged,
}: {
  readonly id: string;
  readonly stepUp: StepUpRunner;
  onDone(): void;
  onChanged(): void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const rpc = getRuntime().rpc;
    stepUp((commandId) => rpc.call("models.logout", { provider: id }, { commandId }))
      .then(
        (done) => {
          if (done === null) return;
          onChanged();
          onDone();
        },
        (failure: unknown) => setError(failureText(failure)),
      )
      .finally(() => setBusy(false));
  };
  return (
    <div data-orphan-key={id} role="group" className="flex flex-col items-start gap-s2">
      <p className="text-ui text-fg">{t("settingsProviders.orphan.note", { name: stripHidden(id) })}</p>
      <div className="flex gap-s2">
        <Button variant="primary" disabled={busy} onClick={remove}>
          {t("settingsProviders.orphan.remove")}
        </Button>
        <Button disabled={busy} onClick={onDone}>
          {t("settingsProviders.orphan.dismiss")}
        </Button>
      </div>
      {error ? <InlineError announce="action">{error}</InlineError> : null}
    </div>
  );
}

/**
 * Mounts the provider form on demand (a chunk of its own; a stale chunk says to reload). It hands the form the
 * ids of the file's providers and of the built-in ones, which the overview already holds.
 */
export function ProviderFormPanel({
  host,
  providers,
  stepUp,
  onChanged,
  onSelect,
}: {
  readonly host: ProviderFormHost;
  readonly providers: readonly ProviderView[];
  readonly stepUp: StepUpRunner;
  onChanged(): void;
  onSelect(id: string): void;
}) {
  const t = useT();
  const cause = usePiCauseText(t);
  const failure = useLazyFailureText();
  const ids = useMemo(
    () => ({
      existing: new Set(providers.filter((one) => one.origin === "models.json").map((one) => one.id)),
      builtin: new Set(providers.filter((one) => one.origin === "builtin").map((one) => one.id)),
    }),
    [providers],
  );
  const { close, setCommented } = host;
  return (
    <>
      {host.pending !== null ? <DiscardConfirm onDiscard={host.discard} onKeep={host.keep} /> : null}
      <LazyPanel
        load={loadForm}
        open={host.form !== null}
        text={failure}
        onFailed={close}
        fallback={<LoadingLine label={t("settingsProviders.loading")} cause={cause} deferred={false} />}
        props={{
          target: host.form ?? {},
          existingIds: ids.existing,
          builtinIds: ids.builtin,
          stepUp,
          onClose: close,
          onSaved: onChanged,
          onFinished: (id: string) => {
            close();
            onSelect(id);
          },
          onKeyStored: onChanged,
          onOrphanKey: (id: string) => {
            host.setOrphanKey(id);
            onChanged();
          },
          onRemoved: () => {
            close();
            onChanged();
          },
          onCommented: setCommented,
          onDirty: host.setDirty,
          onRawEditor: (id: string | null) => {
            close();
            const target =
              id ?? providers.find((one) => one.origin === "models.json")?.id ?? providers[0]?.id;
            if (target !== undefined) onSelect(target);
          },
        }}
      />
    </>
  );
}
