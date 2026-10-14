import { ApiKeyValue } from "@pap/contracts";
import { Button, TextField } from "@pap/ui";
import { useState } from "react";
import { useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { failureText } from "./failure.ts";
import type { StepUpRunner } from "./step-up.ts";

/**
 * Paste an API key (behind the password step-up). The field is emptied the moment the key is taken for sending, so
 * the raw key lives in component state no longer than the typing (M7R133, secrets are not kept after use).
 */
export function ApiKeyForm({
  provider,
  stepUp,
  onSaved,
  onCancel,
}: {
  readonly provider: string;
  readonly stepUp: StepUpRunner;
  onSaved(): void;
  onCancel(): void;
}) {
  const t = useT();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    if (busy) return;
    const parsed = ApiKeyValue.safeParse(value);
    if (!parsed.success) {
      setError(value.trim().startsWith("!") ? t("settingsModels.key.bang") : t("settingsModels.key.invalid"));
      return;
    }
    const key = parsed.data;
    setValue("");
    setBusy(true);
    setError(null);
    const rpc = getRuntime().rpc;
    stepUp((commandId) => rpc.call("models.setApiKey", { provider, key }, { commandId }))
      .then(
        (saved) => {
          if (saved !== null) onSaved();
        },
        (failure: unknown) => setError(failureText(failure)),
      )
      .finally(() => setBusy(false));
  };

  return (
    <form
      className="flex flex-col gap-s2"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <TextField
        label={t("settingsModels.key.label")}
        hint={t("settingsModels.key.hint")}
        value={value}
        onChange={setValue}
        type="password"
        name="api-key"
        autoComplete="off"
        error={error}
        disabled={busy}
      />
      <div className="flex gap-s2">
        <Button type="submit" variant="primary" disabled={busy || value === ""}>
          {t("settingsModels.key.save")}
        </Button>
        <Button disabled={busy} onClick={onCancel}>
          {t("settingsModels.key.cancel")}
        </Button>
      </div>
    </form>
  );
}
