import "../../../i18n/register-settings-providers.ts";
import { Button, useIsPhone } from "@pap/ui";
import { useEffect, useRef, useState } from "react";
import { useT } from "../../../i18n/index.ts";
import { stripHidden } from "../../../lib/untrusted-text.ts";
import { codeText } from "../failure.ts";
import { DiscardConfirm } from "../DiscardConfirm.tsx";
import { DiscoverImport } from "./DiscoverImport.tsx";
import { KeyOffer } from "./KeyOffer.tsx";
import type { StepUpRunner } from "../step-up.ts";
import { HeaderRows } from "./HeaderRows.tsx";
import { ModelRows } from "./ModelRows.tsx";
import { NotEditable } from "./NotEditable.tsx";
import { PresetCards } from "./PresetCards.tsx";
import { AuthFields, ConnectionFields } from "./ProviderFields.tsx";
import { RemoveProvider } from "./RemoveProvider.tsx";
import { useProviderForm } from "./use-provider-form.ts";

export interface ProviderFormProps {
  /** `{}` adds a provider, `{ id }` edits one of `models.json`. */
  readonly target: { readonly id?: string };
  readonly existingIds: ReadonlySet<string>;
  readonly builtinIds: ReadonlySet<string>;
  readonly stepUp: StepUpRunner;
  onClose(): void;
  /** The provider is in the file (the list reloads). `stored`: its key goes to Pi's sign-in file and is typed next. */
  onSaved(id: string, stored: boolean): void;
  /** Nothing more to ask: no key was needed, or it was added or skipped. */
  onFinished(id: string): void;
  /** The key typed after the save is stored (the sign-in state shown by the host changed). */
  onKeyStored(id: string): void;
  /** The provider is gone from the file (the list reloads). */
  onRemoved(id: string): void;
  /** The provider is gone but its key may remain: the host keeps the offer to remove it. */
  onOrphanKey(id: string): void;
  /** A new provider's form learned whether the file has comments (true: Add is off). */
  onCommented(blocked: boolean): void;
  /** Whether the draft holds unsaved changes (the host asks before dropping it). */
  onDirty(dirty: boolean): void;
  /** The raw editor of the provider (null: any provider of the file holds it). */
  onRawEditor(id: string | null): void;
}

/**
 * The provider form (owner q2: starter presets, then one short form). It has no key field and no password input
 * (MPR12, MP-RT-10): a stored key is typed in the existing `ApiKeyForm` after the save.
 */
export function ProviderForm(props: ProviderFormProps) {
  const t = useT();
  const stack = useIsPhone();
  const form = useProviderForm(props);
  const [confirming, setConfirming] = useState(false);
  const { phase, draft } = form;
  const { onDirty } = props;
  const root = useRef<HTMLElement>(null);
  const stage = form.offer !== null ? "offer" : phase.kind === "ready" ? form.step : null;
  // Opening the form, its next step or the key offer brings it into view with its first field focused.
  useEffect(() => {
    if (stage === null || root.current === null) return;
    root.current.scrollIntoView?.({ block: "start" });
    const first = root.current.querySelector<HTMLElement>(
      stage === "offer" ? 'input[name="api-key"]' : "input, button",
    );
    first?.focus({ preventScroll: true });
  }, [stage]);
  useEffect(() => {
    onDirty(form.dirty);
    return () => onDirty(false);
  }, [form.dirty, onDirty]);
  const title = form.editing
    ? t("settingsProviders.title.edit", {
        name: stripHidden((phase.kind === "ready" && draft.name) || props.target.id || ""),
      })
    : t("settingsProviders.title.add");
  const close = () => (form.dirty ? setConfirming(true) : props.onClose());
  const offer = form.offer ?? "";
  const stale = form.saveFailure === "unknown_method";
  const removal = (name: string) =>
    props.target.id === undefined ? null : (
      <RemoveProvider
        // A new read of another provider starts a new confirmation.
        key={props.target.id}
        id={props.target.id}
        name={name}
        revision={form.revision}
        stepUp={props.stepUp}
        reloadRevision={form.reloadRevision}
        disabled={form.busy}
        onRemoved={props.onRemoved}
        onOrphanKey={props.onOrphanKey}
      />
    );
  const fields = {
    draft,
    problems: form.problems,
    refused: form.issues.at,
    editing: form.editing,
    keyHeld: form.keyHeld,
    stack,
    onChange: form.setDraft,
  };

  let body;
  if (form.offer !== null)
    body = (
      <>
        <KeyOffer
          provider={form.offer}
          stepUp={props.stepUp}
          onStored={() => props.onKeyStored(offer)}
          onDone={form.finishOffer}
        />
        {form.saveFailure ? (
          <p role="alert" className="text-ui text-attn">
            {codeText(form.saveFailure)}
          </p>
        ) : null}
      </>
    );
  else if (phase.kind === "loading")
    body = (
      <p role="status" className="text-ui text-muted">
        {t("settingsProviders.loading")}
      </p>
    );
  else if (phase.kind === "failed")
    body = (
      <div className="flex flex-col items-start gap-s2">
        <p role="alert" className="text-ui text-attn">
          {codeText(phase.code)}
        </p>
        <div className="flex gap-s2">
          {phase.code === "unknown_method" ? (
            <Button variant="primary" onClick={() => window.location.reload()}>
              {t("shell.reload")}
            </Button>
          ) : (
            <Button variant="primary" onClick={form.reload}>
              {t("settingsProviders.retry")}
            </Button>
          )}
          <Button onClick={props.onClose}>{t("settingsProviders.close")}</Button>
        </div>
      </div>
    );
  else if (phase.kind === "blocked")
    body = (
      <NotEditable
        reason={phase.reason}
        onRawEditor={() => props.onRawEditor(props.target.id ?? null)}
        onClose={props.onClose}
      >
        {phase.reason === "builtin" || phase.reason === "not_in_file" ? null : removal("")}
      </NotEditable>
    );
  else if (form.step === "preset")
    body = (
      <>
        <PresetCards onPick={form.pickPreset} />
        <div>
          <Button onClick={props.onClose}>{t("settingsProviders.cancel")}</Button>
        </div>
      </>
    );
  else
    body = (
      <>
        <ConnectionFields {...fields} />
        <AuthFields {...fields} />
        <HeaderRows {...fields} />
        <ModelRows {...fields} />
        <DiscoverImport
          provider={form.editing ? (form.id ?? null) : null}
          models={draft.models}
          stepUp={props.stepUp}
          onImport={(added) => form.setDraft({ ...draft, models: [...draft.models, ...added] })}
        />
        {form.advanced ? <p className="text-ui text-muted">{t("settingsProviders.advanced.note")}</p> : null}
        {form.issues.file ? (
          <p role="alert" className="text-ui text-attn">
            {t("settingsProviders.notEditable.needs_raw_editor")}
          </p>
        ) : null}
        {form.issues.providers ? (
          <p role="alert" className="text-ui text-attn">
            {t("settingsProviders.issue.providers")}
          </p>
        ) : null}
        {form.issues.other ? (
          <p role="alert" className="text-ui text-attn">
            {t("settingsProviders.issue.other")}
          </p>
        ) : null}
        {form.conflict ? (
          <div className="flex flex-col items-start gap-s2">
            <p role="alert" className="text-ui text-attn">
              {t("settingsProviders.conflict")}
            </p>
            {form.fileVersion !== null ? (
              <Button onClick={form.showFileVersion}>{t("settingsProviders.conflict.show")}</Button>
            ) : null}
          </div>
        ) : null}
        {form.saveFailure ? (
          <p role="alert" className="text-ui text-attn">
            {codeText(form.saveFailure)}
          </p>
        ) : null}
        {confirming ? (
          <DiscardConfirm onDiscard={props.onClose} onKeep={() => setConfirming(false)} />
        ) : (
          <div className="flex gap-s2">
            {stale ? (
              <Button variant="primary" onClick={() => window.location.reload()}>
                {t("shell.reload")}
              </Button>
            ) : (
              <Button variant="primary" disabled={form.busy || form.problems.length > 0} onClick={form.save}>
                {form.busy ? t("settingsProviders.saving") : t("settingsProviders.save")}
              </Button>
            )}
            <Button disabled={form.busy} onClick={close}>
              {t("settingsProviders.cancel")}
            </Button>
          </div>
        )}
        {form.editing ? removal(draft.name) : null}
      </>
    );

  return (
    <section
      ref={root}
      data-provider-form
      data-layout={stack ? "stack" : "wide"}
      aria-label={title}
      className="flex min-w-0 flex-1 flex-col gap-s4"
    >
      <h2 className="text-h2 text-fg">{title}</h2>
      {body}
    </section>
  );
}
