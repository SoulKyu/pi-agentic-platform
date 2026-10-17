import { useId, useRef, useState } from "react";
import "../../../i18n/register-model-picker.ts";
import { useLazyFailureText, useT } from "../../../i18n/index.ts";
import { LazyPopover } from "../../../lib/LazyPopover.tsx";
import { LazyBoundary, notifyLazyFailure, useRetryableLazy } from "../../../lib/lazy.tsx";
import { shownText, type PickerModel } from "./model-picker.vm.ts";
import { useAvailableModels, type AvailableState } from "./use-available-models.ts";

// The list (search, rows, keys) is a chunk of its own, fetched when the popover opens (MP-RT-09: never a bare lazy).
const loadList = () => import("./ModelList.tsx");

interface ModelRef {
  readonly provider: string;
  readonly modelId: string;
}

export interface ModelPickerFieldProps {
  readonly label: string;
  readonly value: ModelRef | null;
  readonly cwd: string | null;
  /** When set, the first row is "Pi's default" and picking it calls `onChange(null)`. */
  readonly defaultLabel?: string;
  readonly disabled?: boolean;
  readonly hint?: string;
  /** A fixed list for the gallery's figure: `models.available` is not called when it is set. */
  readonly available?: AvailableState;
  onChange(model: ModelRef | null, summary?: PickerModel): void;
}

const TRIGGER_CLASSES =
  "flex h-control w-full items-center justify-between gap-s2 rounded-sm border border-control-border bg-bg px-s2 text-left text-ui text-fg focus-ring pointer-coarse:min-h-11 disabled:cursor-not-allowed disabled:opacity-50";

/**
 * A model chosen from a popover (MPR6): the field is a button, the list loads when it opens. Calls `models.available`
 * only while open. The popover is modal and portalled to the body, also from a dialog (a dialog's panel would clip it).
 */
export function ModelPickerField({
  label,
  value,
  cwd,
  defaultLabel,
  disabled: disabledProp,
  hint,
  available,
  onChange,
}: ModelPickerFieldProps) {
  const disabled = disabledProp ?? false;
  const t = useT();
  const lazyText = useLazyFailureText();
  const id = useId();
  const [open, setOpen] = useState(false);
  const failed = useRef(false);
  const { Lazy: List, attempt, retry } = useRetryableLazy(loadList);
  const fetched = useAvailableModels(cwd, open && available === undefined);
  const state = available ?? fetched;

  const change = (next: boolean) => {
    // A list that failed to load is imported afresh by the next opening.
    if (next && failed.current) {
      failed.current = false;
      retry();
    }
    setOpen(next);
  };

  const missing =
    value !== null &&
    state.status === "ready" &&
    !state.models.some((model) => model.provider === value.provider && model.id === value.modelId);
  const chosen = value === null ? (defaultLabel ?? t("modelPicker.choose")) : shownText(value.modelId);
  const footnote = `${t("modelPicker.footnote.extensions")} ${t("modelPicker.footnote.command")}`;

  return (
    <div className="flex flex-col gap-s1">
      <span id={`${id}-label`} className="label-hud text-muted">
        {label}
      </span>
      <LazyPopover
        open={open}
        onOpenChange={change}
        label={label}
        closeLabel={t("modelPicker.close")}
        text={lazyText}
        trigger={(ask) => (
          <button
            type="button"
            disabled={disabled}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-labelledby={`${id}-label ${id}-value`}
            className={TRIGGER_CLASSES}
            onClick={ask}
          >
            <span id={`${id}-value`} className="flex min-w-0 items-center gap-s2">
              <span className="min-w-0 truncate">{chosen}</span>
              {value === null ? null : (
                <span className="shrink-0 rounded-sm border border-control-border px-s1 text-muted">
                  {shownText(value.provider)}
                </span>
              )}
            </span>
            <span aria-hidden="true" className="shrink-0 text-muted">
              ▾
            </span>
          </button>
        )}
      >
        <LazyBoundary
          resetKey={attempt}
          fallback={
            <p role="status" className="p-s2 text-ui text-muted">
              {t("modelPicker.loading")}
            </p>
          }
          onError={(error) => {
            failed.current = true;
            setOpen(false);
            notifyLazyFailure(error, lazyText);
          }}
        >
          <List
            state={state}
            value={value}
            savedUnavailable={missing ? value : null}
            footnote={footnote}
            {...(defaultLabel === undefined ? {} : { defaultLabel })}
            onPickDefault={() => {
              onChange(null);
              setOpen(false);
            }}
            onPick={(model) => {
              const ref = { provider: model.provider, modelId: model.id };
              // The saved-but-unoffered row has a made-up summary (it claims no reasoning): hand over none.
              if (missing && model.provider === value?.provider && model.id === value.modelId) onChange(ref);
              else onChange(ref, model);
              setOpen(false);
            }}
          />
        </LazyBoundary>
      </LazyPopover>
      {hint ? <p className="text-ui text-muted">{hint}</p> : null}
    </div>
  );
}
