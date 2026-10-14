import { join } from "node:path";
import type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import { CredentialSynchronizationError, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { HELPER_OPS } from "@pap/contracts";
import type { z } from "zod";
import { defineOp, type HelperContext, HelperOpError, type HelperOp } from "../ops.ts";
import { createAuthFileStore, helperErrorOf } from "./auth-store.ts";
import { guardFile } from "./models-open.ts";

type Params<N extends "auth.login" | "auth.setApiKey" | "auth.logout"> = z.infer<
  (typeof HELPER_OPS)[N]["params"]
>;
const OK = { ok: true } as const;

/**
 * Pi's runtime over the Pi file boundary's credential store, side-effect free like `openRuntime` (no catalog refresh, no
 * network, no extension). Pi's own `login` and `logout` call `checkAuth` for the provider they work on; pap's own code
 * never does. No command runs all the same: the store's `read` returns what is stored without resolving it, and Pi's
 * composed check never resolves a stored key, so a `!command` anywhere in auth.json is data (owner c3, MC24). The
 * scripted test provider exists only under `PAP_TEST_PROVIDER=1`.
 */
async function openAuthRuntime(ctx: HelperContext, providerId: string): Promise<ModelRuntime> {
  await guardFile(join(ctx.agentDir, "models.json"), [ctx.agentDir, ctx.home]);
  const runtime = await ModelRuntime.create({
    credentials: createAuthFileStore(ctx),
    modelsPath: join(ctx.agentDir, "models.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  if (process.env.PAP_TEST_PROVIDER === "1") {
    const { buildScriptedAuthProvider, SCRIPTED_AUTH_PROVIDER_ID } =
      await import("../../scripted-provider.ts");
    if (providerId === SCRIPTED_AUTH_PROVIDER_ID) runtime.registerNativeProvider(buildScriptedAuthProvider());
  }
  return runtime;
}

/** The wire form of Pi's event (M7R58 parses it again in the daemon): only the fields the client may show. */
function wireEvent(event: AuthEvent): unknown {
  switch (event.type) {
    case "auth_url":
      return {
        kind: "auth_url",
        url: event.url,
        ...(event.instructions === undefined ? {} : { instructions: event.instructions }),
      };
    case "device_code":
      return {
        kind: "device_code",
        userCode: event.userCode,
        verificationUri: event.verificationUri,
        ...(event.expiresInSeconds === undefined ? {} : { expiresInSeconds: event.expiresInSeconds }),
      };
    case "progress":
      return { kind: "progress", message: event.message };
    case "info":
      return {
        kind: "info",
        message: event.message,
        ...(event.links === undefined
          ? {}
          : {
              links: event.links.map((link) => ({
                url: link.url,
                ...(link.label === undefined ? {} : { label: link.label }),
              })),
            }),
      };
  }
}

function wirePrompt(prompt: AuthPrompt): unknown {
  if (prompt.type === "select")
    return {
      type: "select",
      message: prompt.message,
      options: prompt.options.map((option) => ({
        id: option.id,
        label: option.label,
        ...(option.description === undefined ? {} : { description: option.description }),
      })),
    };
  return {
    type: prompt.type,
    message: prompt.message,
    ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
  };
}

/** Rejects with the prompt's own abort reason: Pi withdraws a prompt when an out-of-band step answered it. */
const withdrawn = (signal: AbortSignal | undefined): Promise<never> =>
  new Promise((_resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

/** The person's answers come from the daemon: a stored key never starts with `!` (it would be run), whoever typed it. */
function interactionFor(ctx: HelperContext, method: "oauth" | "api_key"): AuthInteraction {
  return {
    signal: ctx.signal,
    notify: (event) => ctx.emit(wireEvent(event)),
    prompt: async (prompt) => {
      const answer = await Promise.race([ctx.prompt(wirePrompt(prompt)), withdrawn(prompt.signal)]);
      if (answer === null) throw new HelperOpError("failed", "declined");
      if (method === "api_key" && answer.startsWith("!"))
        throw new HelperOpError("bad_params", "a key cannot be a command");
      return answer;
    },
  };
}

/**
 * Pi commits the credential, then synchronises its own model state; when only that second step failed the credential IS
 * stored (or removed), so the owner is told it worked (MC31). The provider id is all that is noted.
 */
function committed(error: unknown, provider: string): boolean {
  if (!(error instanceof CredentialSynchronizationError)) return false;
  process.stderr.write(`pap-helper: credential changed, model sync failed (${provider})\n`);
  return true;
}

/** What a failed Pi call becomes: a helper error (the cause chain is searched), else a bare failure with no provider text. */
function failure(error: unknown, ctx: HelperContext): HelperOpError {
  const found = helperErrorOf(error);
  if (found) return found;
  return new HelperOpError(
    "failed",
    ctx.signal.aborted ? "cancelled" : `${(error as Error | null)?.name ?? "error"}`,
  );
}

async function signIn(
  ctx: HelperContext,
  provider: string,
  method: "oauth" | "api_key",
  interaction: AuthInteraction,
): Promise<{ ok: true }> {
  const runtime = await openAuthRuntime(ctx, provider);
  const found = runtime.getProvider(provider);
  if (!found) throw new HelperOpError("not_found", "provider");
  if (!(method === "oauth" ? found.auth.oauth : found.auth.apiKey?.login))
    throw new HelperOpError("bad_params", `no ${method} sign-in`);
  try {
    await runtime.login(provider, method, interaction, { agentName: "pap" });
  } catch (error) {
    if (!committed(error, provider)) throw failure(error, ctx);
  }
  return OK;
}

export const login: HelperOp<Params<"auth.login">, { ok: true }> = {
  params: HELPER_OPS["auth.login"].params,
  run: (params, ctx) => signIn(ctx, params.provider, params.method, interactionFor(ctx, params.method)),
};

/** M7R57: Pi's own api-key login, its first secret or text prompt answered with the key; any other prompt cancels. */
export const setApiKey: HelperOp<Params<"auth.setApiKey">, { ok: true }> = {
  params: HELPER_OPS["auth.setApiKey"].params,
  run: (params, ctx) => {
    let answered = false;
    const interaction: AuthInteraction = {
      signal: ctx.signal,
      notify: () => {},
      prompt: async (prompt) => {
        if (answered || (prompt.type !== "secret" && prompt.type !== "text"))
          throw new HelperOpError("bad_params", "the key sign-in asks for more than a key");
        answered = true;
        return params.key;
      },
    };
    return signIn(ctx, params.provider, "api_key", interaction);
  },
};

/** Pi keeps one credential per provider: signing out removes whichever it holds (M7R61). */
export const logout: HelperOp<Params<"auth.logout">, { ok: true }> = {
  params: HELPER_OPS["auth.logout"].params,
  run: async (params, ctx) => {
    const store = createAuthFileStore(ctx);
    const runtime = await openAuthRuntime(ctx, params.provider);
    if (!runtime.getProvider(params.provider) && (await store.read(params.provider)) === undefined)
      throw new HelperOpError("not_found", "provider");
    try {
      await runtime.logout(params.provider, { signal: ctx.signal });
    } catch (error) {
      if (!committed(error, params.provider)) throw failure(error, ctx);
    }
    return OK;
  },
};

export const loginOp = defineOp(login);
export const setApiKeyOp = defineOp(setApiKey);
export const logoutOp = defineOp(logout);
