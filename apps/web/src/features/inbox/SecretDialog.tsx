import "../../i18n/register-inbox.ts";
import { Button, Chip, usePendingAction } from "@pap/ui";
import { Dialog } from "@pap/ui/overlays";
import { useCallback, useId, useRef, useState } from "react";
import { errorKey, useT } from "../../i18n/index.ts";
import { getRuntime, RpcError } from "../../runtime/index.ts";
import { agentById } from "../../stores/agents-reducer.ts";
import { useAgents } from "../../stores/agents-store.ts";
import { useSecretDialog } from "../../stores/secret-dialog-store.ts";
import { useThreadTaint } from "./use-thread-taint.ts";

type Mode = "once" | "vault";

/** Hidden characters (bidi, zero-width, controls) are dropped from the agent's text, never drawn. */
const HIDDEN = /(?![\t\n])\p{Cc}|[\p{Cf}\p{Zl}\p{Zp}]/gu;
const FIELD_CLASSES =
  "h-control w-full rounded-sm border border-control-border bg-bg px-s2 py-s1 font-sans text-ui text-fg focus-ring pointer-coarse:min-h-11 pointer-coarse:text-base";

const close = () => useSecretDialog.getState().close();

/**
 * The secret dialog (M11R130): one agent's `secret.request`, answered with a value used once or saved in the agent's vault.
 * The value lives in the field and in the one call that sends it: no store, no URL, no toast, no log. The field is cleared
 * after the call, when the dialog closes and when it unmounts (sign-out closes the store, MC34).
 */
export default function SecretDialog() {
  const requestId = useSecretDialog((state) => state.requestId);
  return requestId === null ? null : <OpenDialog requestId={requestId} />;
}

function OpenDialog({ requestId }: { readonly requestId: string }) {
  const t = useT();
  const fieldId = useId();
  const field = useRef<HTMLInputElement | null>(null);
  const pending = usePendingAction();
  const [mode, setMode] = useState<Mode>("once");
  const [typed, setTyped] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const request = useAgents((view) =>
    view.requests.find((one) => one.id === requestId && one.kind === "secret"),
  );
  const agent = useAgents((view) => (request === undefined ? undefined : agentById(view, request.agentId)));
  const tainted = useThreadTaint(agent?.threadSessionId ?? null);
  const name = agent?.name ?? t("inbox.agent.someone");

  // One function for the field's whole life: a new one at each render would run the clean-up (and wipe the value) each time.
  const attach = useCallback((node: HTMLInputElement | null) => {
    field.current = node;
    return () => {
      if (node) node.value = "";
      field.current = null;
    };
  }, []);
  const clearField = () => {
    if (field.current) field.current.value = "";
    setTyped(false);
  };
  const send = (call: (rpc: ReturnType<typeof getRuntime>["rpc"]) => Promise<unknown>) =>
    void pending.run(async () => {
      setProblem(null);
      let failed: string | null = null;
      try {
        await call(getRuntime().rpc);
      } catch (failure) {
        failed = t(errorKey(failure instanceof RpcError ? failure.code : "internal"));
      }
      // Cleared whatever the call did; the dialog closes only when it worked.
      clearField();
      if (failed === null) close();
      else setProblem(failed);
    });
  const provide = () => {
    const value = field.current?.value ?? "";
    send((rpc) =>
      rpc.call("secrets.answerRequest", { requestId, value, mode }, { commandId: rpc.newCommandId() }),
    );
  };
  const decline = () =>
    send((rpc) => rpc.call("secrets.declineRequest", { requestId }, { commandId: rpc.newCommandId() }));

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title={t("inbox.secret.title", { name })}
      description={
        request === undefined
          ? undefined
          : t("inbox.secret.what", { secret: request.title.replace(HIDDEN, "") })
      }
      closeLabel={t("ui.close")}
      initialFocus={field}
      footer={
        request === undefined ? (
          <Button onClick={close}>{t("ui.close")}</Button>
        ) : (
          <>
            <Button pendingSince={pending.since} onClick={decline}>
              {t("inbox.secret.decline")}
            </Button>
            <Button variant="primary" pendingSince={pending.since} disabled={!typed} onClick={provide}>
              {t("inbox.secret.provide")}
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-s3 p-s3">
        {request === undefined ? (
          <p role="status" className="text-ui text-muted">
            {t("inbox.secret.gone")}
          </p>
        ) : (
          <>
            {request.detail === null ? null : (
              <figure data-untrusted="" className="flex flex-col gap-s1">
                <figcaption className="label-hud text-attn">{t("inbox.secret.reason")}</figcaption>
                <p className="whitespace-pre-wrap break-words font-mono text-code text-muted">
                  {request.detail.replace(HIDDEN, "")}
                </p>
              </figure>
            )}
            <Taint tainted={tainted} />
            <div className="flex flex-col gap-s1">
              <label htmlFor={fieldId} className="label-hud text-muted">
                {t("inbox.secret.field")}
              </label>
              <input
                id={fieldId}
                ref={attach}
                type="password"
                autoComplete="off"
                spellCheck={false}
                disabled={pending.since !== null}
                onInput={() => setTyped(field.current?.value !== "")}
                className={FIELD_CLASSES}
              />
            </div>
            <fieldset className="flex flex-col gap-s2">
              <legend className="label-hud text-muted">{t("inbox.secret.mode")}</legend>
              <ModeChoice
                value="once"
                mode={mode}
                onPick={setMode}
                label={t("inbox.secret.once")}
                note={t("inbox.secret.onceNote")}
              />
              <ModeChoice
                value="vault"
                mode={mode}
                onPick={setMode}
                label={t("inbox.secret.vault", { name })}
                note={t("inbox.secret.vaultNote")}
              />
            </fieldset>
            {problem !== null ? (
              <p role="alert" className="text-ui text-attn">
                {problem}
              </p>
            ) : null}
          </>
        )}
      </div>
    </Dialog>
  );
}

function Taint({ tainted }: { readonly tainted: boolean | null }) {
  const t = useT();
  if (tainted === null)
    return (
      <p role="status" className="text-ui text-muted">
        {t("inbox.secret.checking")}
      </p>
    );
  if (!tainted) return null;
  return (
    <div className="flex flex-col items-start gap-s1">
      <Chip tone="ext" label={t("inbox.secret.chip")} />
      <p className="text-ui text-attn">{t("inbox.secret.tainted")}</p>
    </div>
  );
}

function ModeChoice({
  value,
  mode,
  label,
  note,
  onPick,
}: {
  readonly value: Mode;
  readonly mode: Mode;
  readonly label: string;
  readonly note: string;
  onPick(value: Mode): void;
}) {
  return (
    <label className="flex items-start gap-s2">
      <input
        type="radio"
        name="secret-mode"
        value={value}
        checked={mode === value}
        onChange={() => onPick(value)}
        className="mt-s1"
      />
      <span className="flex flex-col">
        <span className="text-ui text-fg">{label}</span>
        <span className="text-label text-muted">{note}</span>
      </span>
    </label>
  );
}
