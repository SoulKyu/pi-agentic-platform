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

/** The payload is above the bound: the call is blocked, with its own reason. */
export class InputTooLarge extends UnreadableInput {
  constructor() {
    super();
    this.name = "InputTooLarge";
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
  if (payload.length > MAX_PAYLOAD_CHARS) throw new InputTooLarge();
  const escaped = showHidden(redact(payload), { hidden: 0 });
  // Counts code points without building an array of them.
  let points = 0;
  let cutAt = escaped.length;
  for (let i = 0; i < escaped.length; points++) {
    if (points === AUDIT_ARGS_MAX) cutAt = i;
    i += (escaped.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
  }
  return points > AUDIT_ARGS_MAX ? `${escaped.slice(0, cutAt)}…(+${points - AUDIT_ARGS_MAX})` : escaped;
}
