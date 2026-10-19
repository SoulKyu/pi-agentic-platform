import "./register-settings-catalog.ts";
import { ClaudeToken as TokenValue } from "@pap/contracts";
import { Button, TextField, toast, usePendingAction } from "@pap/ui";
import { useState } from "react";
import { errorKey, type MessageKey, useT } from "../../i18n/index.ts";
import { useStepUpRunner } from "../../lib/step-up-context.tsx";
import { getRuntime, RpcError } from "../../runtime/index.ts";

interface Props {
  /** What `agents.vmStatus` says: the token itself never comes back. */
  readonly state: "set" | "missing";
  /** The token changed: the host reads the status again. */
  onChanged(): void;
}

const failure = (error: unknown): MessageKey =>
  error instanceof RpcError && error.code === "sandbox_unavailable"
    ? "agentVm.unusable"
    : errorKey(error instanceof RpcError ? error.code : "internal");

/**
 * Settings › Agents › Claude token (spec §12, RT-46): write-only like the provider form's keys. The field is emptied the
 * moment the token is taken for sending, so the value lives in component state no longer than the typing; what is shown
 * afterwards is only "Saved" or "Missing". The layout is the provider form's key field (no board of its own).
 */
export function ClaudeToken({ state, onChanged }: Props) {
  const t = useT();
  const stepUp = useStepUpRunner();
  const pending = usePendingAction();
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const editing = state === "missing" || open;
  const parsed = TokenValue.safeParse(value);

  const done = (message: MessageKey) => {
    toast({ message: t(message) });
    setOpen(false);
    onChanged();
  };
  const save = () =>
    void pending.run(async () => {
      if (!parsed.success) {
        setProblem("agentVm.token.invalid");
        return;
      }
      const token = parsed.data;
      setValue("");
      setProblem(null);
      const { rpc } = getRuntime();
      let saved = false;
      let failed: MessageKey | null = null;
      try {
        saved =
          (await stepUp((commandId) => rpc.call("agents.vm.setClaudeToken", { token }, { commandId }))) !==
          null;
      } catch (error) {
        failed = failure(error);
      }
      setProblem(failed);
      if (saved) done("agentVm.token.saved");
    });
  const remove = () =>
    void pending.run(async () => {
      setProblem(null);
      const { rpc } = getRuntime();
      let removed = false;
      let failed: MessageKey | null = null;
      try {
        removed =
          (await stepUp((commandId) => rpc.call("agents.vm.clearClaudeToken", {}, { commandId }))) !== null;
      } catch (error) {
        failed = failure(error);
      }
      setProblem(failed);
      if (removed) done("agentVm.token.removed");
    });

  return (
    <section data-slot="claude-token" aria-labelledby="claude-token-title" className="flex flex-col gap-s2">
      <h3 id="claude-token-title" className="label-hud text-fg">
        {t("agentVm.token.title")}
      </h3>
      <p
        role="status"
        data-token={state}
        className={state === "set" ? "text-ui text-fg" : "text-ui text-attn"}
      >
        {t(state === "set" ? "agentVm.token.set" : "agentVm.token.missing")}
      </p>
      {editing ? (
        <form
          className="flex flex-col gap-s2"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <TextField
            label={t("agentVm.token.label")}
            hint={t("agentVm.token.hint")}
            value={value}
            onChange={(next) => {
              setValue(next);
              setProblem(null);
            }}
            type="password"
            name="claude-token"
            autoComplete="off"
            disabled={pending.since !== null}
          />
          <div className="flex gap-s2">
            <Button type="submit" variant="primary" pendingSince={pending.since} disabled={!parsed.success}>
              {t("agentVm.token.save")}
            </Button>
            {state === "set" ? (
              <Button
                onClick={() => {
                  setValue("");
                  setOpen(false);
                }}
              >
                {t("agentVm.token.cancel")}
              </Button>
            ) : null}
          </div>
        </form>
      ) : (
        <div className="flex gap-s2">
          <Button onClick={() => setOpen(true)}>{t("agentVm.token.replace")}</Button>
          <Button pendingSince={pending.since} onClick={remove}>
            {t("agentVm.token.remove")}
          </Button>
        </div>
      )}
      {problem === null ? null : (
        <p role="alert" className="text-ui text-attn">
          {t(problem)}
        </p>
      )}
    </section>
  );
}
