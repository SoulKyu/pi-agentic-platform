import type { CallFacts, StageResult } from "./pipeline.ts";

export const MIXED_MESSAGE = "the file tool must run in a separate step";
const MIXED_MODEL_REASON = `pap-policy blocked this call: ${MIXED_MESSAGE}.`;

/**
 * W5-R11 (RT-01, RT-12): Pi judges every call of one assistant message before it runs any, and pap's sandboxed shell may
 * change what a path resolves to (a link made in the home) before Pi's host-side file tool opens it. In an agent profile,
 * a message therefore holds a sandboxed shell or Pi path tools, never both: the second kind to be judged is refused,
 * in either order. A call counts once it is allowed; the marker restarts with each message.
 */
export interface MessageMix {
  /** A block when `call` would put a shell and a path tool in the same message; else null. */
  refusal(call: CallFacts): StageResult | null;
  /** Told a call that runs (allowed, or answered "once"). */
  allowed(call: CallFacts): void;
  reset(): void;
}

const concerned = (call: CallFacts): boolean =>
  call.rules.profile === "agent-thread" || call.rules.profile === "isolated-task";

/** Pi's read, write, edit, grep, find and ls, and any other tool whose input names a `path`. */
function namesPath(call: CallFacts): boolean {
  const { kind } = call;
  if (kind.builtin && (kind.category === "read" || kind.category === "edit")) return true;
  return typeof (call.event.input as { path?: unknown } | null)?.path === "string";
}

export function createMessageMix(): MessageMix {
  let shell = false;
  let path = false;
  return {
    refusal(call) {
      if (!concerned(call)) return null;
      const mixed = call.kind.sandboxed === true ? path : namesPath(call) && shell;
      return mixed ? { outcome: "block", reason: MIXED_MESSAGE, modelReason: MIXED_MODEL_REASON } : null;
    },
    allowed(call) {
      if (!concerned(call)) return;
      if (call.kind.sandboxed === true) shell = true;
      else if (namesPath(call)) path = true;
    },
    reset() {
      shell = false;
      path = false;
    },
  };
}
