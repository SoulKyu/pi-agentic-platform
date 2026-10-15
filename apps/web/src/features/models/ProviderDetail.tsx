import type { ModelsOverview, ProviderView } from "@pap/contracts";
import { Button, Chip } from "@pap/ui";
import { useState } from "react";
import { useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { ApiKeyForm } from "./ApiKeyForm.tsx";
import { EnabledSwitches, type SwitchHandlers } from "./EnabledSwitches.tsx";
import { failureText } from "./failure.ts";
import { ModelsJsonEditor } from "./ModelsJsonEditor.tsx";
import { ModelTest } from "./ModelTest.tsx";
import { ProviderUsage } from "./ProviderUsage.tsx";
import { SignInFlow } from "./SignInFlow.tsx";
import { signInState } from "./models.vm.ts";
import type { StepUpRunner } from "./step-up.ts";
import type { useLoginFlow } from "./use-login-flow.ts";

type Login = ReturnType<typeof useLoginFlow>;

function Environment({ provider }: { readonly provider: ProviderView }) {
  const t = useT();
  if (provider.auth.env.length === 0) return null;
  return (
    <div className="flex flex-col gap-s1">
      <p className="text-ui text-muted">{t("settingsModels.signIn.env")}</p>
      <ul className="flex flex-col gap-s1">
        {provider.auth.env.map((variable) => (
          <li key={variable.name} className="font-mono text-ui text-fg">
            {variable.set
              ? t("settingsModels.signIn.envSet", { name: variable.name })
              : t("settingsModels.signIn.envUnset", { name: variable.name })}
          </li>
        ))}
      </ul>
    </div>
  );
}

function statusKey(provider: ProviderView) {
  const { auth } = provider;
  if (signInState(provider) === "unknown") return "settingsModels.signIn.unknown";
  if (auth.stored === "oauth") return "settingsModels.signIn.oauth";
  if (auth.stored === "api_key") return "settingsModels.signIn.apiKey";
  return auth.configured ? "settingsModels.signIn.modelsJson" : "settingsModels.signIn.none";
}

/** Sign in / paste a key / sign out for one provider, or the flow already running for it. */
function SignIn({
  provider,
  login,
  stepUp,
  onChanged,
  onSaid,
}: {
  readonly provider: ProviderView;
  readonly login: Login;
  readonly stepUp: StepUpRunner;
  onChanged(): void;
  onSaid(text: string): void;
}) {
  const t = useT();
  const { flow } = login;
  const [mode, setMode] = useState<"idle" | "key" | "signOut">("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mine = flow?.provider === provider.id;
  const otherRunning = flow !== null && !mine;

  const signOut = () => {
    setBusy(true);
    setError(null);
    const rpc = getRuntime().rpc;
    rpc
      .call("models.logout", { provider: provider.id }, { commandId: rpc.newCommandId() })
      .then(
        () => {
          setMode("idle");
          onSaid(t("settingsModels.signOut.done"));
        },
        (failure: unknown) => setError(failureText(failure)),
      )
      .finally(() => {
        setBusy(false);
        onChanged();
      });
  };

  if (mine && flow)
    return (
      <SignInFlow
        flow={flow}
        providerName={provider.name}
        onAnswer={login.answer}
        onCancel={() => void login.cancel()}
        onClose={login.dismiss}
      />
    );
  const { oauthLabel, apiKey, stored } = provider.auth;
  return (
    <div className="flex flex-col gap-s2">
      <p className="text-ui text-fg">{t(statusKey(provider))}</p>
      <Environment provider={provider} />
      {login.stuck === provider.id ? (
        <div role="alert" className="flex flex-col items-start gap-s2">
          <p className="text-ui text-attn">{t("settingsModels.flow.stuck")}</p>
          <Button onClick={() => void login.cancelProvider(provider.id)}>
            {t("settingsModels.flow.stuckCancel")}
          </Button>
        </div>
      ) : null}
      {otherRunning ? (
        <p className="text-ui text-muted">
          {t("settingsModels.signIn.elsewhere", { provider: flow.provider })}
        </p>
      ) : null}
      {oauthLabel === null && !apiKey ? (
        <p className="text-ui text-muted">{t("settingsModels.signIn.noMethod")}</p>
      ) : null}
      {mode === "key" ? (
        <ApiKeyForm
          provider={provider.id}
          stepUp={stepUp}
          onSaved={() => {
            setMode("idle");
            onSaid(t("settingsModels.key.saved"));
            onChanged();
          }}
          onCancel={() => setMode("idle")}
        />
      ) : null}
      {mode === "signOut" ? (
        <div
          role="group"
          aria-label={t("settingsModels.signOut.ask", { provider: provider.name })}
          className="flex flex-col items-start gap-s2"
        >
          <p className="text-ui text-fg">{t("settingsModels.signOut.ask", { provider: provider.name })}</p>
          <div className="flex gap-s2">
            <Button variant="primary" disabled={busy} onClick={signOut}>
              {t("settingsModels.signOut.confirm")}
            </Button>
            <Button disabled={busy} onClick={() => setMode("idle")}>
              {t("settingsModels.key.cancel")}
            </Button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-ui text-attn">
          {error}
        </p>
      ) : null}
      {mode === "idle" ? (
        <div className="flex flex-wrap gap-s2">
          {oauthLabel !== null ? (
            <Button
              variant="primary"
              disabled={otherRunning || login.starting !== null}
              onClick={() => void login.start(provider.id, "oauth")}
            >
              {t("settingsModels.signIn.withProvider", { label: oauthLabel })}
            </Button>
          ) : null}
          {apiKey ? (
            <Button disabled={otherRunning} onClick={() => setMode("key")}>
              {t("settingsModels.signIn.pasteKey")}
            </Button>
          ) : null}
          {stored !== null ? (
            <Button onClick={() => setMode("signOut")}>{t("settingsModels.signOut")}</Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ProviderDetail({
  provider,
  defaults,
  readOnly,
  pending,
  login,
  stepUp,
  handlers,
  pricingOn,
  onPricingForbidden,
  dirty,
  onDirty,
  onChanged,
  onSaid,
}: {
  readonly provider: ProviderView;
  readonly defaults: ModelsOverview["defaults"];
  readonly readOnly: boolean;
  readonly pending: ReadonlySet<string>;
  readonly login: Login;
  readonly stepUp: StepUpRunner;
  readonly handlers: SwitchHandlers;
  readonly pricingOn: boolean;
  readonly dirty: boolean;
  onDirty(dirty: boolean): void;
  onPricingForbidden(): void;
  onChanged(): void;
  onSaid(text: string): void;
}) {
  const t = useT();
  return (
    <div data-provider-detail={provider.id} className="flex min-w-0 flex-1 flex-col gap-s4">
      <div className="flex flex-wrap items-center gap-s2">
        <h2 className="text-h2 text-fg">{provider.name}</h2>
        <Chip
          tone="mut"
          label={
            provider.origin === "builtin"
              ? t("settingsModels.origin.builtin")
              : t("settingsModels.origin.modelsJson")
          }
        />
      </div>
      <section aria-label={t("settingsModels.signIn.title")} className="flex flex-col gap-s2">
        <h3 className="label-hud text-muted">{t("settingsModels.signIn.title")}</h3>
        <SignIn provider={provider} login={login} stepUp={stepUp} onChanged={onChanged} onSaid={onSaid} />
      </section>
      <EnabledSwitches
        provider={provider}
        readOnly={readOnly}
        pending={pending}
        defaultModel={defaults.provider === provider.id ? defaults.model : null}
        handlers={handlers}
      />
      {provider.models.length > 0 ? <ModelTest key={provider.id} provider={provider} /> : null}
      <ProviderUsage key={`usage-${provider.id}`} providerId={provider.id} />
      <ModelsJsonEditor
        provider={provider}
        stepUp={stepUp}
        pricingOn={pricingOn}
        onPricingForbidden={onPricingForbidden}
        dirty={dirty}
        onDirty={onDirty}
        onChanged={onChanged}
      />
    </div>
  );
}
