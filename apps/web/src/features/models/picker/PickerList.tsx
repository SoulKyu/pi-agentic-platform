import { useEffect, useMemo } from "react";
import "../../../i18n/register-model-picker.ts";
import { useT } from "../../../i18n/index.ts";
import { useExtensionRead } from "../extension-read.ts";
import { ExtensionControls } from "./ExtensionControls.tsx";
import { extensionView, isOffered, mayBeExtension } from "./extension-models.vm.ts";
import ModelList, { type ExtensionPart } from "./ModelList.tsx";
import type { PickerModel } from "./model-picker.vm.ts";
import type { AvailableState } from "./use-available-models.ts";

interface ModelRef {
  readonly provider: string;
  readonly modelId: string;
}

export interface PickerListProps {
  readonly state: AvailableState;
  readonly value: ModelRef | null;
  readonly defaultLabel?: string;
  /** False for a fixed list (the gallery's figure): no extension is read. */
  readonly extensions: boolean;
  /** False: the run loads no extension (Chat only): their part says so, and a saved model of theirs is not offered. */
  readonly extensionsLoaded: boolean;
  onPickDefault(): void;
  /** `summary` is absent for the saved-but-unoffered row: its made-up summary claims no reasoning. */
  onPick(model: ModelRef, summary?: PickerModel): void;
  /** What the list knows of `value` once it is ready: offered, not offered, or not known (it may be an extension's). */
  onValueStatus?(status: ValueStatus): void;
}

/** `not-offered-chat`: not offered because the run loads no extension (Chat only) and Pi has no such provider. */
export type ValueStatus = "offered" | "not-offered" | "not-offered-chat" | "unknown";

const NO_MODELS: readonly PickerModel[] = [];
const NO_PROVIDERS: ReadonlyMap<string, string> = new Map();

/**
 * The list of the no-session picker (the agent form, the new-lane dialog): `models.available`, plus the models the
 * owner's global extensions register once a click read them (ADR 0070 as amended). The read lives in a store for the
 * tab, shared with Settings. Lazy: the field imports this module when its popover opens; the session menu does not.
 */
export default function PickerList({
  state,
  value,
  defaultLabel,
  extensions,
  extensionsLoaded,
  onPickDefault,
  onPick,
  onValueStatus,
}: PickerListProps) {
  const t = useT();
  const read = useExtensionRead();
  const listed = state.status === "ready" ? state.models : NO_MODELS;
  const view = useMemo(
    () =>
      extensions && extensionsLoaded && read.status === "ready" ? extensionView(read.answer, listed) : null,
    [extensions, extensionsLoaded, read, listed],
  );
  const missing = value !== null && state.status === "ready" && !isOffered(value, listed, view);
  // Every provider Pi has without extensions when the daemon says them, else the ones the list shows (review M4).
  const providers = state.status === "ready" ? (state.known ?? state.labels) : NO_PROVIDERS;
  const extensionNote = missing && extensions && extensionsLoaded && mayBeExtension(value, providers, view);
  const footnote = `${t("modelPicker.footnote.extensions")} ${t("modelPicker.footnote.command")}`;
  const status: ValueStatus | null =
    value === null || state.status !== "ready"
      ? null
      : !missing
        ? "offered"
        : extensionNote
          ? "unknown"
          : extensions && !extensionsLoaded && mayBeExtension(value, providers, null)
            ? "not-offered-chat"
            : "not-offered";
  useEffect(() => {
    if (status !== null) onValueStatus?.(status);
  }, [status, onValueStatus]);
  const extension = useMemo<ExtensionPart | undefined>(
    () =>
      extensions
        ? {
            models: view?.models ?? NO_MODELS,
            labels: view?.labels ?? NO_PROVIDERS,
            modelsTruncated: view?.modelsTruncated ?? new Set(),
            controls: extensionsLoaded ? (
              <ExtensionControls read={read} view={view} />
            ) : (
              <p data-extension-controls className="px-s2 text-ui text-muted">
                {t("modelPicker.extensions.noneHere")}
              </p>
            ),
          }
        : undefined,
    [extensions, extensionsLoaded, read, view, t],
  );

  return (
    <ModelList
      state={state}
      value={value}
      savedUnavailable={missing ? value : null}
      {...(extensionNote ? { savedNote: t("modelPicker.savedExtension") } : {})}
      footnote={footnote}
      {...(extension ? { extension } : {})}
      {...(defaultLabel === undefined ? {} : { defaultLabel })}
      onPickDefault={onPickDefault}
      onPick={(model) => {
        const ref = { provider: model.provider, modelId: model.id };
        if (missing && model.provider === value?.provider && model.id === value.modelId) onPick(ref);
        else onPick(ref, model);
      }}
    />
  );
}
