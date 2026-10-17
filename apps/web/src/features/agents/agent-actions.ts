import { errorKey, type MessageKey } from "../../i18n/index.ts";
import type { StepUpRunner } from "../../lib/step-up-context.tsx";
import { getRuntime, RpcError } from "../../runtime/index.ts";

/** What a refused pause or resume says (T21): a half-deleted agent (`conflict`) and a quarantine still running (`session_busy`). */
function resumeRefusalKey(failure: unknown): MessageKey {
  const code = failure instanceof RpcError ? failure.code : "internal";
  return code === "conflict"
    ? "agentSafety.resume.conflict"
    : code === "session_busy"
      ? "agentSafety.resume.busy"
      : errorKey(code);
}

/**
 * `agents.setPaused`. Clearing a quarantine asks for the password (T21), so `stepUp` is given for that case and only then.
 * Returns the words of a refusal, or null when it worked or the password prompt was cancelled.
 */
export async function setPaused(
  agentId: string,
  paused: boolean,
  stepUp: StepUpRunner | null,
): Promise<MessageKey | null> {
  const { rpc } = getRuntime();
  const call = (commandId: string) => rpc.call("agents.setPaused", { agentId, paused }, { commandId });
  // The choice is made before the try: the React Compiler bails out on a conditional inside one.
  const send = stepUp === null ? () => call(rpc.newCommandId()) : () => stepUp(call);
  let failure: unknown = null;
  try {
    await send();
  } catch (caught) {
    failure = caught;
  }
  return failure === null ? null : resumeRefusalKey(failure);
}
