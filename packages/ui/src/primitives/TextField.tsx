import { useId } from "react";
import { cn } from "../cn.ts";
import { isSubmitShortcut } from "./submit-shortcut.ts";

export interface TextFieldProps {
  readonly label: string;
  readonly value: string;
  onChange(value: string): void;
  readonly type?: "text" | "password";
  readonly hint?: string;
  readonly error?: string | null;
  readonly multiline?: boolean;
  readonly name?: string;
  readonly placeholder?: string;
  readonly autoComplete?: string;
  readonly disabled?: boolean;
  onSubmitShortcut?(): void;
}

const FIELD_CLASSES = cn(
  "w-full rounded-sm border border-control-border bg-bg px-s2 py-s1 font-sans text-fg focus-ring pointer-coarse:min-h-11 pointer-coarse:text-base",
  "disabled:cursor-not-allowed disabled:opacity-50",
);

export function TextField(props: TextFieldProps) {
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
          className={cn(FIELD_CLASSES, "text-chat")}
          rows={3}
          onChange={(event) => props.onChange(event.target.value)}
          onKeyDown={(event) => {
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
          className={cn(FIELD_CLASSES, "h-control text-ui")}
          type={props.type ?? "text"}
          onChange={(event) => props.onChange(event.target.value)}
        />
      )}
      {props.hint ? (
        <p id={hintId} className="text-ui text-muted">
          {props.hint}
        </p>
      ) : null}
      {props.error ? (
        <p id={errorId} role="alert" className="text-ui text-attn">
          {props.error}
        </p>
      ) : null}
    </div>
  );
}
