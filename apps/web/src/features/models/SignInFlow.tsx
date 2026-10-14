import type { LoginPrompt } from "@pap/contracts";
import { Button, TextField } from "@pap/ui";
import { useState } from "react";
import { useT } from "../../i18n/index.ts";
import { codeText } from "./failure.ts";
import type { FlowView } from "./models.vm.ts";
import type { LoginFlow } from "./use-login-flow.ts";

const LINK = "text-agent underline focus-ring";

/** The fixed text of how a flow ended; the provider's own words never stand in for it. */
function doneText(done: NonNullable<FlowView["done"]>, t: ReturnType<typeof useT>): string {
  if (done.ok) return t("settingsModels.flow.done.ok");
  if (done.code === "timeout") return t("settingsModels.flow.done.timeout");
  return done.code ? codeText(done.code) : t("settingsModels.flow.done.failed");
}

function PromptForm({
  promptId,
  prompt,
  onAnswer,
}: {
  readonly promptId: string;
  readonly prompt: LoginPrompt;
  onAnswer(promptId: string, value: string): Promise<void>;
}) {
  const t = useT();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  const send = (answer: string) => {
    if (busy) return;
    // Emptied before the call: a secret is not kept in state once it left the field.
    setValue("");
    setBusy(true);
    void onAnswer(promptId, answer).finally(() => setBusy(false));
  };

  if (prompt.type === "select") {
    return (
      <div role="group" aria-label={prompt.message} className="flex flex-col gap-s2">
        <p className="text-ui text-fg">{prompt.message}</p>
        {prompt.options.map((option) => (
          <Button key={option.id} disabled={busy} onClick={() => send(option.id)}>
            {option.label}
          </Button>
        ))}
      </div>
    );
  }
  const label =
    prompt.type === "manual_code"
      ? t("settingsModels.flow.manual")
      : prompt.message || t("settingsModels.flow.value");
  return (
    <form
      className="flex flex-col gap-s2"
      onSubmit={(event) => {
        event.preventDefault();
        if (value !== "") send(value);
      }}
    >
      <TextField
        label={label}
        value={value}
        onChange={setValue}
        type={prompt.type === "secret" ? "password" : "text"}
        name="login-answer"
        autoComplete="off"
        disabled={busy}
        {...(prompt.placeholder ? { placeholder: prompt.placeholder } : {})}
      />
      <div>
        <Button type="submit" variant="primary" disabled={busy || value === ""}>
          {t("settingsModels.flow.answer")}
        </Button>
      </div>
    </form>
  );
}

function DeviceCode({ device }: { readonly device: NonNullable<FlowView["device"]> }) {
  const t = useT();
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const copyCode = () => {
    navigator.clipboard.writeText(device.userCode).then(
      () => setCopy("copied"),
      // Said to the person as "Select the code and copy it": the refusal never stays silent.
      () => setCopy("failed"),
    );
  };
  return (
    <div className="flex flex-col gap-s2">
      <p className="label-hud text-muted">{t("settingsModels.flow.deviceCode")}</p>
      <div className="flex items-center gap-s2">
        <span data-device-code className="font-mono text-h2 text-fg">
          {device.userCode}
        </span>
        <Button onClick={copyCode}>{t("settingsModels.flow.copy")}</Button>
      </div>
      {copy === "copied" ? (
        <p role="status" className="text-ui text-muted">
          {t("settingsModels.flow.copied")}
        </p>
      ) : null}
      {copy === "failed" ? (
        <p role="status" className="text-ui text-attn">
          {t("settingsModels.flow.copyFailed")}
        </p>
      ) : null}
      {device.expiresInSeconds ? (
        <p className="text-ui text-muted">
          {t("settingsModels.flow.deviceExpires", {
            minutes: Math.max(1, Math.round(device.expiresInSeconds / 60)),
          })}
        </p>
      ) : null}
      <a href={device.verificationUri} target="_blank" rel="noopener noreferrer" className={LINK}>
        {t("settingsModels.flow.deviceOpen")}
      </a>
    </div>
  );
}

/**
 * One sign-in flow as it unfolds (M7R69): a link to open on the owner's own device, a device code with a copy button,
 * a field for what the provider asks for, and a Cancel that is never the danger one. Everything the provider says is
 * rendered as React text; links are the https or loopback ones the contract already vetted.
 */
export function SignInFlow({
  flow,
  providerName,
  onAnswer,
  onCancel,
  onClose,
}: {
  readonly flow: LoginFlow;
  readonly providerName: string;
  onAnswer(promptId: string, value: string): Promise<void>;
  onCancel(): void;
  onClose(): void;
}) {
  const t = useT();
  const { view } = flow;
  return (
    <div data-sign-in-flow className="flex flex-col gap-s3">
      {view.done ? (
        <p role="status" className="text-ui text-fg">
          {doneText(view.done, t)}
        </p>
      ) : (
        <p role="status" className="text-ui text-fg">
          {t("settingsModels.flow.running", { provider: providerName })}
        </p>
      )}
      {view.link ? (
        <div className="flex flex-col gap-s1">
          <a href={view.link.url} target="_blank" rel="noopener noreferrer" className={LINK}>
            {t("settingsModels.flow.open")}
          </a>
          <p className="text-ui text-muted">{t("settingsModels.flow.openHint")}</p>
          {view.link.instructions ? <p className="text-ui text-fg">{view.link.instructions}</p> : null}
        </div>
      ) : null}
      {view.device ? <DeviceCode device={view.device} /> : null}
      {view.notes.length > 0 ? (
        <ul className="flex flex-col gap-s1">
          {view.notes.map((note, index) => (
            <li key={`${index}:${note}`} className="text-ui text-muted">
              {note}
            </li>
          ))}
        </ul>
      ) : null}
      {view.links.length > 0 ? (
        <ul className="flex flex-col gap-s1">
          {view.links.map((link, index) => (
            <li key={index}>
              <a href={link.url} target="_blank" rel="noopener noreferrer" className={LINK}>
                {link.label ?? link.url}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {view.prompt ? (
        <PromptForm
          key={view.prompt.promptId}
          promptId={view.prompt.promptId}
          prompt={view.prompt.prompt}
          onAnswer={onAnswer}
        />
      ) : null}
      {flow.error ? (
        <p role="alert" className="text-ui text-attn">
          {flow.error}
        </p>
      ) : null}
      <div>
        {view.done ? (
          <Button onClick={onClose}>{t("settingsModels.flow.close")}</Button>
        ) : (
          <Button onClick={onCancel}>{t("settingsModels.flow.cancel")}</Button>
        )}
      </div>
    </div>
  );
}
