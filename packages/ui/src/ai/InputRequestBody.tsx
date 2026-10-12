import { useState } from "react";
import { Button } from "../primitives/Button.tsx";
import { TextField } from "../primitives/TextField.tsx";

export interface SelectRequest {
  readonly kind: "select";
  /** Option labels as they are shown; the same label may appear twice, so answers go by position. */
  readonly options: readonly string[];
  readonly cancelLabel: string;
  onSelect(index: number): void;
  onCancel(): void;
}
export interface ConfirmRequest {
  readonly kind: "confirm";
  readonly yesLabel: string;
  readonly noLabel: string;
  onConfirm(confirmed: boolean): void;
}
export interface TextRequest {
  readonly kind: "text";
  /** Many lines: Enter types and Ctrl or Cmd+Enter submits. One line: Enter submits. */
  readonly multiline?: boolean;
  /** What the field holds at first. */
  readonly initialValue: string;
  readonly placeholder?: string | undefined;
  readonly submitLabel: string;
  readonly cancelLabel: string;
  onSubmit(value: string): void;
  onCancel(): void;
}
/** What the caller answers with, by kind. */
export type InputRequestAnswers = SelectRequest | ConfirmRequest | TextRequest;
export type InputRequestBodyProps = InputRequestAnswers & {
  /** The request was answered: its buttons and field stay shut. */
  readonly answered: boolean;
  /** The field's label for a text request (the title, which a text request does not repeat as a heading). */
  readonly fieldLabel: string;
};

function TextBody(props: TextRequest & { readonly answered: boolean; readonly fieldLabel: string }) {
  const [value, setValue] = useState(props.initialValue);
  const submit = () => props.onSubmit(value);
  return (
    <form
      className="flex flex-col gap-s2"
      onSubmit={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        // A single-line field submits on Enter; the Enter that confirms an input-method composition does not.
        if (
          event.key === "Enter" &&
          !event.nativeEvent.isComposing &&
          event.target instanceof HTMLInputElement
        ) {
          event.preventDefault();
          if (!props.answered) submit();
        }
      }}
    >
      <TextField
        label={props.fieldLabel}
        value={value}
        onChange={setValue}
        multiline={props.multiline === true}
        disabled={props.answered}
        placeholder={props.placeholder}
        onSubmitShortcut={submit}
      />
      <div className="flex flex-wrap gap-s2">
        <Button variant="primary" disabled={props.answered} onClick={submit}>
          {props.submitLabel}
        </Button>
        <Button disabled={props.answered} onClick={props.onCancel}>
          {props.cancelLabel}
        </Button>
      </div>
    </form>
  );
}

/** The answers of an input request: option buttons, yes / no, or a text field. Presentational: the caller answers once. */
export function InputRequestBody(props: InputRequestBodyProps) {
  if (props.kind === "text") return <TextBody {...props} />;
  return (
    <div className="flex flex-wrap gap-s2">
      {props.kind === "select" ? (
        <>
          {props.options.map((option, index) => (
            // The same label may be offered twice: the position tells the buttons apart.
            <Button key={index} disabled={props.answered} onClick={() => props.onSelect(index)}>
              {option}
            </Button>
          ))}
          <Button disabled={props.answered} onClick={props.onCancel}>
            {props.cancelLabel}
          </Button>
        </>
      ) : (
        <>
          <Button variant="primary" disabled={props.answered} onClick={() => props.onConfirm(true)}>
            {props.yesLabel}
          </Button>
          <Button disabled={props.answered} onClick={() => props.onConfirm(false)}>
            {props.noLabel}
          </Button>
        </>
      )}
    </div>
  );
}
