import "./register-catalog.ts";
import type { ModelsOverview } from "@pap/contracts";
import { Button, useIsPhone } from "@pap/ui";
import { useCallback, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { DiscardConfirm } from "./DiscardConfirm.tsx";
import { failureText } from "./failure.ts";
import { readOnlyPath, writeFailureText } from "./models.vm.ts";
import { ProviderDetail } from "./ProviderDetail.tsx";
import { PricingSwitch } from "./PricingSwitch.tsx";
import { ProviderList } from "./ProviderList.tsx";
import type { StepUpRunner } from "./step-up.ts";
import { useOverview } from "./use-overview.ts";
import { useLoginFlow } from "./use-login-flow.ts";
import { useModelWrites } from "./use-model-writes.ts";
import { usePricingSetting } from "./use-pricing-setting.ts";

const DEFAULT_KEY = "default";

function Defaults({ defaults }: { readonly defaults: ModelsOverview["defaults"] }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-s1">
      <h3 className="label-hud text-muted">{t("settingsModels.defaults.title")}</h3>
      <p className="text-ui text-fg">
        {defaults.provider !== null && defaults.model !== null
          ? t("settingsModels.defaults.value", { model: defaults.model, provider: defaults.provider })
          : t("settingsModels.defaults.none")}
      </p>
      <p className="text-ui text-muted">
        {defaults.thinkingLevel === null
          ? t("settingsModels.defaults.unknown")
          : t("settingsModels.defaults.level", { level: defaults.thinkingLevel })}
      </p>
    </div>
  );
}

/**
 * Settings › Models (M7R68): providers with their sign-in state, a detail pane with sign-in, key, sign-out, the
 * provider and model switches and the default star, and "Refresh catalog". The providers are read again after every
 * change: the list is the truth, never the call.
 */
export function ModelsSection({ stepUp }: { readonly stepUp: StepUpRunner }) {
  const t = useT();
  const phone = useIsPhone();
  const list = useOverview();
  const overview = list.value;
  const [refreshing, setRefreshing] = useState(false);
  const path = overview ? readOnlyPath(overview.enabled) : null;
  const failure = useCallback((error: unknown) => writeFailureText(error, path), [path]);
  const writes = useModelWrites(list.reload, failure);
  const login = useLoginFlow({ stepUp, onFinished: list.reload });
  // A sign-in restored after a reload belongs to its provider: that one is selected from the start and stays so.
  const [selected, setSelected] = useState<string | null>(() => login.flow?.provider ?? null);
  const [dirty, setDirty] = useState(false);
  const [switchTo, setSwitchTo] = useState<string | null>(null);
  const pricing = usePricingSetting();

  const write = (key: string, call: () => Promise<unknown>, done?: string) =>
    writes.run(key, async () => {
      await call();
      return done ?? null;
    });
  const rpc = () => getRuntime().rpc;

  const refresh = () => {
    setRefreshing(true);
    writes.say(null);
    rpc()
      .call("models.refreshCatalog", {}, { commandId: rpc().newCommandId() })
      .then(
        (result) =>
          writes.say({
            tone: "status",
            text: result.offline
              ? t("settingsModels.refresh.offline")
              : result.failedProviders.length > 0
                ? t("settingsModels.refresh.failed", { providers: result.failedProviders.join(", ") })
                : result.changed
                  ? t("settingsModels.refresh.done")
                  : t("settingsModels.refresh.unchanged"),
          }),
        (error: unknown) => writes.say({ tone: "error", text: failureText(error) }),
      )
      .finally(() => {
        setRefreshing(false);
        list.reload();
      });
  };

  if (overview === null)
    return (
      <div data-models-section className="flex flex-col items-start gap-s2">
        {list.error ? (
          <>
            <p role="alert" className="text-ui text-attn">
              {list.error}
            </p>
            <Button onClick={list.reload}>{t("settingsModels.retry")}</Button>
          </>
        ) : (
          <p role="status" className="text-ui text-muted">
            {t("settingsModels.loading")}
          </p>
        )}
      </div>
    );

  const provider = overview.providers.find((one) => one.id === selected) ?? null;
  const choose = (id: string) => {
    if (dirty && id !== selected) setSwitchTo(id);
    else setSelected(id);
  };
  return (
    <div data-models-section className="flex flex-col gap-s4">
      <p className="text-ui text-muted">{t("settingsModels.intro")}</p>
      <div className="flex flex-wrap items-start justify-between gap-s4">
        <Defaults defaults={overview.defaults} />
        <Button disabled={refreshing || overview.offline} onClick={refresh}>
          {t("settingsModels.refresh")}
        </Button>
      </div>
      <PricingSwitch setting={pricing} />
      {overview.offline ? <p className="text-ui text-muted">{t("settingsModels.offline")}</p> : null}
      {overview.truncated ? <p className="text-ui text-muted">{t("settingsModels.truncated")}</p> : null}
      {path !== null ? (
        <p className="text-ui text-muted">{t("settingsModels.scope.project", { path })}</p>
      ) : null}
      {list.error ? (
        <p role="alert" className="text-ui text-attn">
          {list.error}
        </p>
      ) : null}
      {login.notice ? (
        <p role="alert" className="text-ui text-attn">
          {login.notice}
        </p>
      ) : null}
      {writes.notice ? (
        <p
          role={writes.notice.tone === "error" ? "alert" : "status"}
          className={writes.notice.tone === "error" ? "text-ui text-attn" : "text-ui text-muted"}
        >
          {writes.notice.text}
        </p>
      ) : null}
      {switchTo !== null ? (
        <DiscardConfirm
          onDiscard={() => {
            setDirty(false);
            setSelected(switchTo);
            setSwitchTo(null);
          }}
          onKeep={() => setSwitchTo(null)}
        />
      ) : null}
      <div className={phone ? "flex flex-col gap-s4" : "flex items-start gap-s4"}>
        <div className={phone ? "" : "w-64 shrink-0"}>
          <ProviderList providers={overview.providers} selected={selected} onSelect={choose} />
        </div>
        {provider ? (
          <ProviderDetail
            key={provider.id}
            provider={provider}
            defaults={overview.defaults}
            readOnly={path !== null}
            pending={writes.pending}
            login={login}
            stepUp={stepUp}
            pricingOn={pricing.on}
            dirty={dirty}
            onDirty={setDirty}
            onPricingForbidden={pricing.reload}
            onChanged={list.reload}
            onSaid={(text) => writes.say({ tone: "status", text })}
            handlers={{
              onProvider: (on) =>
                void write(`p:${provider.id}`, () =>
                  rpc().call(
                    "models.setEnabled",
                    { op: { op: "provider", provider: provider.id, enabled: on } },
                    { commandId: rpc().newCommandId() },
                  ),
                ),
              onModel: (modelId, on) =>
                void write(`m:${provider.id}/${modelId}`, () =>
                  rpc().call(
                    "models.setEnabled",
                    { op: { op: "toggle", provider: provider.id, modelId, enabled: on } },
                    { commandId: rpc().newCommandId() },
                  ),
                ),
              onStar: (modelId) =>
                void write(
                  DEFAULT_KEY,
                  () =>
                    rpc().call(
                      "models.setDefault",
                      { provider: provider.id, modelId },
                      { commandId: rpc().newCommandId() },
                    ),
                  t("settingsModels.star.saved"),
                ),
            }}
          />
        ) : (
          <p className="text-ui text-muted">{t("settingsModels.pick")}</p>
        )}
      </div>
    </div>
  );
}
