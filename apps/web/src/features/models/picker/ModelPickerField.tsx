import { LoadingLine } from "@pap/ui";
import { useCallback, useId, useRef, useState } from "react";
import "../../../i18n/register-model-picker.ts";
import { useLazyFailureText, useT } from "../../../i18n/index.ts";
import "../../../i18n/register-launch.ts";
import { usePiCauseText } from "../../../stores/loading-cause.ts";
import { LazyPopover } from "../../../lib/LazyPopover.tsx";
import { LazyBoundary, notifyLazyFailure, useRetryableLazy } from "../../../lib/lazy.tsx";
import { shownText, type PickerModel } from "./model-picker.vm.ts";
import { useAvailableModels, type AvailableState } from "./use-available-models.ts";

// The list (search, rows, keys, the extension models) is a chunk of its own, fetched when the popover opens (MP-RT-09:
// never a bare lazy).
const loadList = () => import("./PickerList.tsx");

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
  /** False: the run loads no extension (an agent in Chat only), so none of their models is offered (default true). */
  readonly extensionsLoaded?: boolean;
  onChange(model: ModelRef | null, summary?: PickerModel): void;
}

const TRIGGER_CLASSES =
  "flex h-control w-full items-center justify-between gap-s2 rounded-sm border border-control-border bg-bg px-s2 text-left text-ui text-fg focus-ring pointer-coarse:min-h-11 disabled:cursor-not-allowed disabled:opacity-50";

/**
 * A model chosen from a popover (MPR6): the field is a button, the list loads when it opens. Calls `models.available`
 * only while open, and `models.extensions` only on the list's own click. The popover is modal and portalled to the
 * body, also from a dialog (a dialog's panel would clip it).
 */
export function ModelPickerField({
  label,
  value,
  cwd,
  defaultLabel,
  disabled: disabledProp,
  hint,
  available,
  extensionsLoaded,
  onChange,
}: ModelPickerFieldProps) {
  const disabled = disabledProp ?? false;
  const t = useT();
  const cause = usePiCauseText(t);
  const lazyText = useLazyFailureText();
  const id = useId();
  const [open, setOpen] = useState(false);
  const failed = useRef(false);
  const { Lazy: List, attempt, retry } = useRetryableLazy(loadList);
  const fetched = useAvailableModels(cwd, open && available === undefined);
  const state = available ?? fetched;
  // What the list last said of this value: "not offered" stays under the field once closed, never blocking a save.
  const [said, setSaid] = useState<{ readonly value: ModelRef; readonly status: string } | null>(null);
  const onValueStatus = useCallback(
    (status: string) => setSaid(value === null ? null : { value, status }),
    [value],
  );
  const heard =
    said !== null &&
    value !== null &&
    said.value.provider === value.provider &&
    said.value.modelId === value.modelId
      ? said.status
      : null;
  // Under Chat only the preset, not the selection, keeps an extension's model out (review N2).
  const notOffered =
    heard === "not-offered"
      ? t("modelPicker.notOfferedHint")
      : heard === "not-offered-chat"
        ? t("modelPicker.notOfferedChatHint")
        : null;

  const change = (next: boolean) => {
    // A list that failed to load is imported afresh by the next opening.
    if (next && failed.current) {
      failed.current = false;
      retry();
    }
    setOpen(next);
  };

  const chosen = value === null ? (defaultLabel ?? t("modelPicker.choose")) : shownText(value.modelId);

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
            <div className="p-s2">
              <LoadingLine label={t("modelPicker.loading")} cause={cause} deferred={false} />
            </div>
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
            extensions={available === undefined}
            extensionsLoaded={extensionsLoaded ?? true}
            onValueStatus={onValueStatus}
            {...(defaultLabel === undefined ? {} : { defaultLabel })}
            onPickDefault={() => {
              onChange(null);
              setOpen(false);
            }}
            onPick={(ref, summary) => {
              if (summary === undefined) onChange(ref);
              else onChange(ref, summary);
              setOpen(false);
            }}
          />
        </LazyBoundary>
      </LazyPopover>
      {notOffered === null ? null : (
        <p data-model-not-offered className="text-ui text-attn">
          {notOffered}
        </p>
      )}
      {hint ? <p className="text-ui text-muted">{hint}</p> : null}
    </div>
  );
}
