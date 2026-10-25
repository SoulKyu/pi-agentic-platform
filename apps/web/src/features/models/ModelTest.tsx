import type { ModelsTestResult, ProviderView } from "@pap/contracts";
import { Button, Heading, InlineError, TextField } from "@pap/ui";
import { useState } from "react";
import { useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { failureText } from "./failure.ts";
import { providerCodeText } from "./models-json.vm.ts";

/**
 * One small request to a model, to see that the key, the address and the id work. No password step-up (it sends the
 * key to the provider the owner already set up); the answer is a pass with its latency or a fixed code text.
 */
export function ModelTest({ provider }: { readonly provider: ProviderView }) {
  const t = useT();
  const [modelId, setModelId] = useState(provider.models[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ModelsTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = () => {
    if (busy || modelId.trim() === "") return;
    setBusy(true);
    setResult(null);
    setError(null);
    const rpc = getRuntime().rpc;
    rpc
      .call(
        "models.test",
        { provider: provider.id, modelId: modelId.trim() },
        { commandId: rpc.newCommandId() },
      )
      .then(setResult, (failure: unknown) => setError(failureText(failure)))
      .finally(() => setBusy(false));
  };

  return (
    <section aria-label={t("settingsModels.test.title")} className="flex flex-col gap-s2">
      <Heading level={3} variant="group">
        {t("settingsModels.test.title")}
      </Heading>
      <TextField
        label={t("settingsModels.test.model")}
        value={modelId}
        onChange={setModelId}
        name="test-model"
        autoComplete="off"
        disabled={busy}
      />
      <div>
        <Button disabled={busy || modelId.trim() === ""} onClick={run}>
          {t("settingsModels.test.button")}
        </Button>
      </div>
      {result?.ok === true ? (
        <p role="status" className="text-ui text-fg">
          {t("settingsModels.test.ok", { ms: result.latencyMs })}
        </p>
      ) : null}
      {result !== null && !result.ok ? (
        <InlineError announce="action">{providerCodeText(result.code)}</InlineError>
      ) : null}
      {error ? <InlineError announce="action">{error}</InlineError> : null}
    </section>
  );
}
