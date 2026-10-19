import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * RT-03, R13, worker side: in a VM session the image's models.json holds placeholders only, so every provider's key is the
 * launch's relay key (Pi sends it in the provider's own credential header, which the relay judges), and the bridge's
 * `claude` gets it as its token before it starts. Memory only: `setRuntimeApiKey` is Pi's non-persistent overlay, nothing
 * is written to a file, and this process's environment is its own.
 */
export async function applyRelayKey(
  runtime: Pick<ModelRuntime, "setRuntimeApiKey">,
  key: string,
  providers: readonly string[],
): Promise<void> {
  for (const provider of providers) await runtime.setRuntimeApiKey(provider, key);
  process.env.ANTHROPIC_AUTH_TOKEN = key;
}
