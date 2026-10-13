import { TextField } from "@pap/ui";
import type { ReactNode } from "react";
import { useT } from "../../i18n/index.ts";
import type { ParsedLines } from "./policy-settings.vm.ts";

/** Lines listed one by one; the rest are counted, so a pasted file never fills the screen. */
const SHOWN_ERRORS = 5;

interface PatternFieldProps {
  readonly kind: "pattern" | "host";
  readonly label: string;
  readonly hint: string;
  readonly text: string;
  readonly parsed: ParsedLines;
  readonly max: number;
  readonly disabled?: boolean;
  onChange(text: string): void;
  readonly children?: ReactNode;
}

/** One entry per line in a text area; every line is checked against the contract on each change. */
export function PatternField(props: PatternFieldProps) {
  const t = useT();
  const { kind, max, parsed } = props;
  const messages = parsed.errors.slice(0, SHOWN_ERRORS).map((error) => {
    const vars = { line: error.line, max };
    if (error.reason === "too_many")
      return t(kind === "host" ? "approvals.error.tooManyHosts" : "approvals.error.tooManyPatterns", vars);
    return t(kind === "host" ? "approvals.error.host" : "approvals.error.pattern", vars);
  });
  const more = parsed.errors.length - SHOWN_ERRORS;
  if (more > 0) messages.push(t("approvals.error.more", { count: more }));
  return (
    <div className="flex flex-col gap-s2">
      <TextField
        multiline
        label={props.label}
        hint={props.hint}
        value={props.text}
        onChange={props.onChange}
        error={messages.length > 0 ? messages.join(" ") : null}
        disabled={props.disabled}
      />
      {props.children}
    </div>
  );
}
