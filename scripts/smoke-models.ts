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
const LOCAL_ID = "smoke-local";
const LOCAL_MODEL = "smoke-model";
/** Loopback, `auth: none`: the form's own policy accepts it, and the smoke never connects to it. */
const LOCAL_URL = "http://127.0.0.1:9/v1";

export interface ModelsContext {
  /** The smoke's `PI_CODING_AGENT_DIR`. */
  readonly agentDir: string;
  readonly socket: SmokeSocket;
  /** Confirms the owner's password for this login (`POST /auth/confirm`): a provider save asks for it. */
  readonly stepUp: () => Promise<void>;
}

/** Run after the search step. */
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

  // Chain B through the built helper entry (MP-RT-21): the form's read, save and read again, then the picker list.
  const fresh = asJson(await ctx.socket.call("models.provider.get", {}));
  if (fresh.editable !== false || fresh.reason !== "not_in_file")
    throw new Error(`models.provider.get without an id answered ${JSON.stringify(fresh)}`);
  if (typeof fresh.revision !== "string" || !REVISION.test(fresh.revision))
    throw new Error(`models.provider.get gave no 64-hex revision: ${JSON.stringify(fresh.revision)}`);
  step("models.provider.get answers not_in_file and a 64-hex revision");

  await ctx.stepUp();
  const provider = {
    id: LOCAL_ID,
    api: "openai-completions",
    baseUrl: LOCAL_URL,
    auth: { kind: "none" },
    headers: [],
    models: [{ id: LOCAL_MODEL }],
  };
  await ctx.socket.call(
    "models.provider.save",
    { mode: "create", id: LOCAL_ID, provider, baseRevision: fresh.revision },
    true,
  );
  const saved = asJson(await ctx.socket.call("models.provider.get", { id: LOCAL_ID }));
  const readBack = asJson(saved.provider);
  if (saved.editable !== true || readBack.id !== LOCAL_ID || readBack.baseUrl !== LOCAL_URL)
    throw new Error(
      `models.provider.get did not return the saved provider editable: ${JSON.stringify(saved)}`,
    );
  step(`models.provider.save wrote ${LOCAL_ID} and models.provider.get returns it editable`);

  const after = asJson(await ctx.socket.call("models.available", {}));
  const offered = (Array.isArray(after.models) ? after.models.map(asJson) : []).filter(
    (model) => model.provider === LOCAL_ID,
  );
  if (offered.length !== 1 || offered[0]?.id !== LOCAL_MODEL)
    throw new Error(`models.available did not list ${LOCAL_ID}/${LOCAL_MODEL}: ${JSON.stringify(after)}`);
  step(`models.available lists ${LOCAL_ID}/${LOCAL_MODEL} (a keyless loopback provider, nothing contacted)`);

  // The keyless provider has no stored key: removing it with the box ticked must still succeed (final-review I2).
  await ctx.stepUp();
  await ctx.socket.call(
    "models.provider.remove",
    { id: LOCAL_ID, baseRevision: String(saved.revision), alsoRemoveKey: true },
    true,
  );
  const gone = asJson(await ctx.socket.call("models.provider.get", { id: LOCAL_ID }));
  if (gone.editable !== false || gone.reason !== "not_in_file")
    throw new Error(`models.provider.get after the removal answered ${JSON.stringify(gone)}`);
  step(`models.provider.remove took ${LOCAL_ID} with the key box ticked and no key stored`);
}
