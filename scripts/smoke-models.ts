// The smoke's models step (MP-RT-21, the M11a I2 guard for the built helper entry): the built daemon must answer
// `models.available` through the built helper entry. A plain key for one built-in provider is written into the smoke's
// temporary agent folder; the list must hold that provider's models and none of an unsigned provider's. Nothing leaves
// the machine: the smoke runs under the network guard, and the key is not a real one.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { asJson, type SmokeSocket, step } from "./smoke-lib.ts";

const SIGNED_IN = "anthropic";
const UNSIGNED = "openai";
const REVISION = /^[0-9a-f]{64}$/;

export interface ModelsContext {
  /** The smoke's `PI_CODING_AGENT_DIR`. */
  readonly agentDir: string;
  readonly socket: SmokeSocket;
}

/** Run after the search step. Task 15 extends it with the provider save. */
export async function checkModels(ctx: ModelsContext): Promise<void> {
  mkdirSync(ctx.agentDir, { recursive: true });
  const auth = { [SIGNED_IN]: { type: "api_key", key: "pap-smoke-not-a-real-key" } };
  writeFileSync(join(ctx.agentDir, "auth.json"), JSON.stringify(auth), { mode: 0o600 });

  const answer = asJson(await ctx.socket.call("models.available", {}));
  const models = Array.isArray(answer.models) ? answer.models.map(asJson) : [];
  if (models.length === 0)
    throw new Error(
      `models.available listed no model for a signed-in ${SIGNED_IN}: ${JSON.stringify(answer)}`,
    );
  const providers = [...new Set(models.map((model) => String(model.provider)))];
  if (providers.length !== 1 || providers[0] !== SIGNED_IN)
    throw new Error(`models.available listed providers ${providers.join(", ")}, expected only ${SIGNED_IN}`);
  if (models.some((model) => model.provider === UNSIGNED))
    throw new Error(`models.available listed a model of the unsigned provider ${UNSIGNED}`);
  step(`models.available lists ${models.length} ${SIGNED_IN} model(s) and none of ${UNSIGNED}`);

  // Placeholder until chain B: task 15 swaps this step for `models.provider.get`. It proves a second helper op answers,
  // not that `models.available` reached the helper (the step above does).
  const config = asJson(await ctx.socket.call("models.config.get", {}));
  if (typeof config.revision !== "string" || !REVISION.test(config.revision))
    throw new Error(`models.config.get gave no 64-hex revision: ${JSON.stringify(config.revision)}`);
  step("models.config.get answers a 64-hex revision");
}
