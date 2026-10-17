import { Button } from "@pap/ui";
import { useT } from "../../../i18n/index.ts";
import { ApiKeyForm } from "../ApiKeyForm.tsx";
import type { StepUpRunner } from "../step-up.ts";

/**
 * After a stored provider is saved: the existing `ApiKeyForm` (step-up, empties itself, `autoComplete="off"`) for that
 * id, or Skip to leave the provider without a key. The key never passes through the provider form (MPR12, MP-RT-10).
 */
export function KeyOffer({
  provider,
  stepUp,
  onStored,
  onDone,
}: {
  readonly provider: string;
  readonly stepUp: StepUpRunner;
  /** The key is stored: the host reloads what shows the sign-in state. */
  onStored(): void;
  onDone(): void;
}) {
  const t = useT();
  return (
    <section data-key-offer={provider} className="flex flex-col gap-s2">
      <p role="status" className="text-ui text-fg">
        {t("settingsProviders.saved")}
      </p>
      <ApiKeyForm
        provider={provider}
        stepUp={stepUp}
        onSaved={() => {
          onStored();
          onDone();
        }}
        onCancel={onDone}
      />
      <div>
        <Button onClick={onDone}>{t("settingsProviders.key.skip")}</Button>
      </div>
    </section>
  );
}
