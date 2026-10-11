import { useId } from "react";
import { cn } from "../cn.ts";
import { FOCUS_RING } from "../focus.ts";

export interface TextFieldProps {
  readonly label: string;
  readonly value: string;
  onChange(value: string): void;
  readonly type?: "text" | "password";
  readonly hint?: string;
  readonly error?: string | null;
  readonly multiline?: boolean;
  readonly name?: string;
  readonly autoComplete?: string;
  readonly disabled?: boolean;
  onSubmitShortcut?(): void;
}

const FIELD = cn(
  "w-full rounded-sm border border-line bg-bg px-2 py-1 font-sans text-chat text-fg pointer-coarse:min-h-11",
  FOCUS_RING,
);

export function TextField(props: TextFieldProps) {
  const id = useId();
  const noteId = `${id}-note`;
  const note = props.error || props.hint;
  const shared = {
    id,
    name: props.name,
    value: props.value,
    disabled: props.disabled,
    autoComplete: props.autoComplete,
    "aria-describedby": note ? noteId : undefined,
    "aria-invalid": props.error ? true : undefined,
    className: FIELD,
  };
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="font-mono text-label font-semibold uppercase tracking-label text-muted">
        {props.label}
      </label>
      {props.multiline ? (
        <textarea
          {...shared}
          rows={3}
          onChange={(event) => props.onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) props.onSubmitShortcut?.();
          }}
        />
      ) : (
        <input
          {...shared}
          type={props.type ?? "text"}
          onChange={(event) => props.onChange(event.target.value)}
        />
      )}
      {note ? (
        <p id={noteId} className={props.error ? "text-ui text-attention" : "text-ui text-muted"}>
          {note}
        </p>
      ) : null}
    </div>
  );
}
