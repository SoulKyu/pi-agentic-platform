import { REPLAY, type EffectKind } from "./store.ts";

/**
 * Tests only (M10R80): where a test freezes an effect so it can kill the daemon there. `<kind>`: the handler is not
 * called (the row is leased, no sent mark). `<kind>:sent`: the handler stops right after its sent mark. `cancel`: the
 * task runner's Cancel stops right after its commit, before it aborts the session.
 */
export type OutboxHold = EffectKind | `${EffectKind}:sent` | "cancel";

const HOLDS: ReadonlySet<string> = new Set([
  ...Object.keys(REPLAY),
  ...Object.keys(REPLAY).map((kind) => `${kind}:sent`),
  "cancel",
]);

/** Never echoes the value. Honoured only beside the scripted provider: a production daemon never holds an effect. */
export function parseOutboxHold(
  raw: string | undefined,
  scripted: boolean,
  error: (message: string) => Error,
): OutboxHold | null {
  if (raw === undefined) return null;
  if (!scripted) throw error("PAP_TEST_OUTBOX_HOLD needs PAP_TEST_PROVIDER_SCRIPT");
  if (!HOLDS.has(raw)) throw error("PAP_TEST_OUTBOX_HOLD must be <kind>, <kind>:sent or cancel");
  return raw as OutboxHold;
}
