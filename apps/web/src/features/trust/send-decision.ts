import { t } from "../../i18n/index.ts";
import type { StepUpRunner } from "../../lib/step-up-context.tsx";
import { getRuntime, RpcError } from "../../runtime/index.ts";
import { refusalText, trustFailureText } from "./trust.vm.ts";

/**
 * `applied`: the decision is recorded. Otherwise `problem` says why, or is null when the person cancelled the password
 * prompt (nothing changed). `unknown`: the call timed out or the connection dropped, so the write may have landed (R105).
 */
export type Outcome =
  | { readonly applied: true }
  | { readonly applied: false; readonly problem: string | null; readonly unknown?: true };

const outcomeUnknown = (failure: unknown): boolean =>
  failure instanceof RpcError && (failure.code === "timeout" || failure.code === "connection_lost");

/**
 * Sends `trust.set`. Trusting runs the folder's code later, so it goes through the shell's password prompt; keeping it
 * untrusted only narrows and does not (MC47). A breach of the breadth rule is an answer of the call (`ok: false`), not an error.
 */
export async function sendDecision(cwd: string, decision: boolean, stepUp: StepUpRunner): Promise<Outcome> {
  try {
    const rpc = getRuntime().rpc;
    const send = (commandId: string) => rpc.call("trust.set", { cwd, decision }, { commandId });
    const result = decision ? await stepUp(send) : await send(rpc.newCommandId());
    if (result === null) return { applied: false, problem: null };
    return result.ok ? { applied: true } : { applied: false, problem: refusalText(result.refusal) };
  } catch (failure) {
    // Never retried here: the status is read again and the person decides.
    return outcomeUnknown(failure)
      ? { applied: false, problem: t("trust.unknown"), unknown: true }
      : { applied: false, problem: trustFailureText(failure) };
  }
}
