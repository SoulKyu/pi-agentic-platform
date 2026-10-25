import { useId, type ClipboardEvent, type DragEvent, type KeyboardEvent, type RefObject } from "react";
import { cn } from "../cn.ts";
import { InlineError } from "./InlineError.tsx";
import { isSubmitShortcut } from "./submit-shortcut.ts";

/** A listbox this field drives (a mention or command menu): the four attributes of the combobox pattern. */
export interface TextFieldCombobox {
  readonly expanded: boolean;
  /** The id of the listbox. */
  readonly controls: string;
  /** The id of the highlighted option, or null. */
  readonly activeDescendant: string | null;
}

export interface TextFieldProps {
  readonly label: string;
  readonly value: string;
  onChange(value: string): void;
  readonly type?: "text" | "password";
  readonly hint?: string;
  readonly error?: string | null;
  readonly multiline?: boolean;
  /** `surface`: the field sits on the raised surface token, as the composer does (board 09); `bg`: the page ground. */
  readonly ground?: "bg" | "surface";
  /** Multiline only: monospace text and a taller box, for code and configuration. */
  readonly mono?: boolean;
  readonly rows?: number;
  /** Single line only: whole numbers (MB, CPUs); the numeric keyboard on a phone and tabular figures so digits align (DESIGN.md §4). */
  readonly numeric?: boolean;
  readonly name?: string;
  readonly placeholder?: string;
  readonly autoComplete?: string;
  readonly disabled?: boolean;
  onSubmitShortcut?(): void;
  /** Multiline only. Runs before the submit shortcut; an event it prevented does not submit (M8R83). */
  onKeyDown?(event: KeyboardEvent<HTMLTextAreaElement>): void;
  readonly inputRef?: RefObject<HTMLTextAreaElement | null>;
  onPaste?(event: ClipboardEvent<HTMLTextAreaElement>): void;
  onDrop?(event: DragEvent<HTMLTextAreaElement>): void;
  onDragOver?(event: DragEvent<HTMLTextAreaElement>): void;
  /** Null or absent: the field is a plain textarea. */
  readonly combobox?: TextFieldCombobox | null;
}

const FIELD_CLASSES = cn(
  "w-full rounded-sm border border-control-border px-s2 py-s1 text-fg focus-ring pointer-coarse:min-h-11 pointer-coarse:text-base",
  "disabled:cursor-not-allowed disabled:opacity-50",
);
const GROUNDS = { bg: "bg-bg", surface: "bg-surface" } as const;

export function TextField({ inputRef, ...props }: TextFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const described = [props.hint ? hintId : "", props.error ? errorId : ""].filter(Boolean).join(" ");
  const shared = {
    id,
    name: props.name,
    placeholder: props.placeholder,
    value: props.value,
    disabled: props.disabled,
    autoComplete: props.autoComplete,
    "aria-describedby": described || undefined,
    "aria-invalid": props.error ? true : undefined,
  };
  return (
    <div className="flex flex-col gap-s1">
      <label htmlFor={id} className="label-hud text-muted">
        {props.label}
      </label>
      {props.multiline ? (
        <textarea
          {...shared}
          {...(props.combobox
            ? {
                role: "combobox",
                "aria-expanded": props.combobox.expanded,
                "aria-controls": props.combobox.controls,
                "aria-activedescendant": props.combobox.activeDescendant ?? undefined,
                "aria-autocomplete": "list" as const,
              }
            : {})}
          ref={inputRef}
          className={cn(
            FIELD_CLASSES,
            GROUNDS[props.ground ?? "bg"],
            props.mono ? "font-mono text-ui" : "font-sans text-chat",
          )}
          rows={props.rows ?? 3}
          onChange={(event) => props.onChange(event.target.value)}
          onPaste={props.onPaste}
          onDrop={props.onDrop}
          onDragOver={props.onDragOver}
          onKeyDown={(event) => {
            props.onKeyDown?.(event);
            if (event.defaultPrevented) return;
            // Handled here: the browser must not also add a line break for the same keystroke.
            if (props.onSubmitShortcut && isSubmitShortcut(event)) {
              event.preventDefault();
              props.onSubmitShortcut();
            }
          }}
        />
      ) : (
        <input
          {...shared}
          className={cn(
            FIELD_CLASSES,
            GROUNDS[props.ground ?? "bg"],
            "h-control font-sans text-ui",
            props.numeric ? "tabular-nums" : "",
          )}
          type={props.type ?? "text"}
          inputMode={props.numeric ? "numeric" : undefined}
          onChange={(event) => props.onChange(event.target.value)}
        />
      )}
      {props.hint ? (
        <p id={hintId} className="text-pretty text-ui text-muted">
          {props.hint}
        </p>
      ) : null}
      {props.error ? (
        <InlineError id={errorId} announce="action">
          {props.error}
        </InlineError>
      ) : null}
    </div>
  );
}
