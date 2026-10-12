import { AUDIT_ARGS_MAX } from "@pap/contracts";
import { showHidden } from "./describe-call.ts";
import { grantPayload } from "./grant-key.ts";

export const UNREADABLE_INPUT = "[unreadable input]";
/** A shell command above this is not stated at all: the call is blocked as an evaluation error. */
const MAX_PAYLOAD_CHARS = 2 * 1024 * 1024;

export class UnreadableInput extends Error {
  constructor() {
    super("the tool input cannot be stated");
    this.name = "UnreadableInput";
  }
}

/**
 * What the audit shows of a call (M5R13): the shell command alone for a built-in shell call, else the canonical JSON of
 * the input; redacted, then hidden characters escaped as in the approval card, then clipped to 2 048 code points.
 */
export function auditArgs(input: unknown, exec: boolean, redact: (text: string) => string): string {
  let payload: string;
  try {
    payload = grantPayload(input, exec).payload;
  } catch {
    throw new UnreadableInput();
  }
  if (payload.length > MAX_PAYLOAD_CHARS) throw new UnreadableInput();
  const escaped = showHidden(redact(payload), { hidden: 0 });
  const points = [...escaped];
  return points.length > AUDIT_ARGS_MAX
    ? `${points.slice(0, AUDIT_ARGS_MAX).join("")}…(+${points.length - AUDIT_ARGS_MAX})`
    : escaped;
}
