import { errorKey, t } from "../../i18n/index.ts";
import { RpcError } from "../../runtime/index.ts";

/**
 * Runs a mutation; when the server wants a fresh password (`step_up_required`) asks the person once and, if they
 * confirmed, sends it once more with the same `commandId`: the first attempt stored no receipt, so this is still
 * one intent (R124). A cancel, or a second `step_up_required`, leaves the original error. Any other failure,
 * `timeout` and `connection_lost` included (outcome unknown, R105), is never retried here.
 */
export async function withStepUp<T>(
  run: (commandId: string) => Promise<T>,
  ask: () => Promise<boolean>,
  commandId: string,
): Promise<T> {
  try {
    return await run(commandId);
  } catch (failure) {
    if (!(failure instanceof RpcError) || failure.code !== "step_up_required") throw failure;
    if (!(await ask())) throw failure;
    return run(commandId);
  }
}

/** The i18n text of the code only: the server's message never reaches the screen. */
export const failureText = (failure: unknown): string =>
  t(errorKey(failure instanceof RpcError ? failure.code : "internal"));
