import type { PricingEntry, ProviderView } from "@pap/contracts";
import { Button, Heading, InlineError, TextField } from "@pap/ui";
import { useRef, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { failureCode, failureText } from "./failure.ts";
import { priceSummary, setModelCost } from "./models-json.vm.ts";

/**
 * Looks up a model's prices on models.dev, on click only, and fills them into the editor's draft: nothing is saved
 * here (M7R138). It is rendered only while the owner's models.dev switch is on; a `forbidden` answer means it was
 * switched off elsewhere, so the setting is read again and this control goes away.
 */
export function PricingLookup({
  provider,
  draft,
  onDraft,
  onForbidden,
}: {
  readonly provider: ProviderView;
  readonly draft: string;
  onDraft(text: string): void;
  onForbidden(): void;
}) {
  const t = useT();
  const [modelId, setModelId] = useState(provider.models[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  // The answer is bound to the id it was asked for; editing the id drops it.
  const [looked, setLooked] = useState<{ id: string; entries: readonly PricingEntry[] } | null>(null);
  const asked = useRef(0);
  const entries = looked?.entries ?? null;
  const [notice, setNotice] = useState<{ tone: "error" | "status"; text: string } | null>(null);

  const lookUp = () => {
    if (busy || modelId.trim() === "") return;
    setBusy(true);
    setNotice(null);
    setLooked(null);
    const id = modelId.trim();
    const mine = ++asked.current;
    getRuntime()
      .rpc.call("models.pricing", { modelId: id })
      .then(
        (answer) => {
          if (mine === asked.current) setLooked({ id, entries: answer.entries });
        },
        (failure: unknown) => {
          if (failureCode(failure) === "forbidden") onForbidden();
          setNotice({ tone: "error", text: failureText(failure) });
        },
      )
      .finally(() => setBusy(false));
  };

  const use = (entry: PricingEntry) => {
    if (looked === null) return;
    const next = setModelCost(draft, provider.id, looked.id, entry);
    if (next === null) {
      setNotice({ tone: "error", text: t("settingsModels.pricing.missing") });
      return;
    }
    onDraft(next);
    setNotice({ tone: "status", text: t("settingsModels.pricing.filled") });
  };

  return (
    <section aria-label={t("settingsModels.pricing.title")} className="flex flex-col gap-s2">
      <Heading level={3} variant="group">
        {t("settingsModels.pricing.title")}
      </Heading>
      <TextField
        label={t("settingsModels.test.model")}
        value={modelId}
        onChange={(value) => {
          asked.current += 1;
          setLooked(null);
          setNotice(null);
          setModelId(value);
        }}
        name="pricing-model"
        autoComplete="off"
        disabled={busy}
      />
      <div>
        <Button disabled={busy || modelId.trim() === ""} onClick={lookUp}>
          {t("settingsModels.pricing.button")}
        </Button>
      </div>
      {entries !== null && entries.length === 0 ? (
        <p role="status" className="text-ui text-muted">
          {t("settingsModels.pricing.none")}
        </p>
      ) : null}
      {entries !== null && entries.length > 0 ? (
        <ul className="flex flex-col gap-s2">
          {entries.map((entry, index) => (
            <li key={index} className="flex flex-col items-start gap-s1">
              <p className="text-ui text-fg">
                {entry.provider}: {priceSummary(entry)}
              </p>
              <Button onClick={() => use(entry)}>
                {t("settingsModels.pricing.use", { provider: entry.provider })}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {notice ? (
        notice.tone === "error" ? (
          <InlineError announce="action">{notice.text}</InlineError>
        ) : (
          <p role="status" className="text-ui text-muted">
            {notice.text}
          </p>
        )
      ) : null}
    </section>
  );
}
