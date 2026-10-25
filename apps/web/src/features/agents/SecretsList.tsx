import "./register-space-catalog.ts";
import { VaultName, type SecretEntry } from "@pap/contracts";
import { Button, InlineError, TextField, usePendingAction, LoadingLine } from "@pap/ui";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { errorKey, type MessageKey, useLocale, useT } from "../../i18n/index.ts";
import { getRuntime, RpcError } from "../../runtime/index.ts";

type Load =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly entries: readonly SecretEntry[]; readonly readable: boolean }
  | { readonly kind: "failed" };

const FIELD_CLASSES =
  "h-control w-full rounded-sm border border-control-border bg-bg px-s2 py-s1 font-sans text-ui text-fg focus-ring pointer-coarse:min-h-11 pointer-coarse:text-base";

const failureKey = (failure: unknown): MessageKey =>
  errorKey(failure instanceof RpcError ? failure.code : "internal");

/**
 * An agent's vault (M11R126, M11R85): the names and when each was saved, never a value. A value is typed in a masked field
 * that React does not own: it lives in the field and in the one call that sends it, and is cleared after that call whatever
 * it answered. No store, URL, toast or log gets it. The copy says what the encryption protects against and what it does not.
 */
export function SecretsList({ agentId }: { readonly agentId: string }) {
  const t = useT();
  const locale = useLocale();
  const problemId = useId();
  const valueId = useId();
  const field = useRef<HTMLInputElement | null>(null);
  const adding = usePendingAction();
  const deleting = usePendingAction();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [name, setName] = useState("");
  const [typed, setTyped] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const latest = useRef(0);

  const read = useCallback(async () => {
    latest.current += 1;
    const mine = latest.current;
    let next: Load;
    try {
      const answer = await getRuntime().rpc.call("secrets.list", { agentId });
      next = { kind: "ready", entries: answer.entries, readable: answer.state === "ok" };
    } catch {
      next = { kind: "failed" };
    }
    if (mine === latest.current) setLoad(next);
  }, [agentId]);
  useEffect(() => {
    void read();
    return () => {
      latest.current += 1;
    };
  }, [read]);

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

  const add = () =>
    void adding.run(async () => {
      const parsed = VaultName.safeParse(name);
      if (!parsed.success) {
        setProblem("agentSafety.secrets.name.invalid");
        return;
      }
      setProblem(null);
      const { rpc } = getRuntime();
      const value = field.current?.value ?? "";
      let failed: MessageKey | null = null;
      try {
        await rpc.call(
          "secrets.set",
          { agentId, name: parsed.data, value },
          { commandId: rpc.newCommandId() },
        );
      } catch (failure) {
        failed = failureKey(failure);
      }
      // Cleared whatever the call did.
      clearField();
      setProblem(failed);
      if (failed === null) {
        setName("");
        await read();
      }
    });
  const remove = (target: string) =>
    void deleting.run(async () => {
      setProblem(null);
      const { rpc } = getRuntime();
      let failed: MessageKey | null = null;
      try {
        await rpc.call("secrets.delete", { agentId, name: target }, { commandId: rpc.newCommandId() });
      } catch (failure) {
        failed = failureKey(failure);
      }
      setConfirming(null);
      setProblem(failed);
      await read();
    });

  const date = (at: number) => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(at);
  return (
    <section data-agent-secrets="" className="flex flex-col gap-s3">
      <h3 className="text-h2 text-fg">{t("agentSafety.secrets.title")}</h3>
      <div className="flex flex-col gap-s1 text-ui text-muted">
        <p>{t("agentSafety.secrets.intro")}</p>
        <p>{t("agentSafety.secrets.limits")}</p>
        <p>{t("agentSafety.secrets.protects")}</p>
        <p>{t("agentSafety.secrets.notAgainst.process")}</p>
        <p>{t("agentSafety.secrets.notAgainst.backup")}</p>
      </div>
      {load.kind === "loading" ? (
        <LoadingLine label={t("agentSafety.secrets.loading")} />
      ) : load.kind === "failed" ? (
        <InlineError announce="background">{t("agentSafety.secrets.failed")}</InlineError>
      ) : !load.readable ? (
        <InlineError announce="background">{t("agentSafety.secrets.unreadable")}</InlineError>
      ) : (
        <>
          {load.entries.length === 0 ? (
            <p className="text-ui text-muted">{t("agentSafety.secrets.empty")}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
              {load.entries.map((entry) => (
                <li key={entry.name} className="flex flex-wrap items-center gap-s2 p-s2">
                  <span className="min-w-0 flex-1 truncate font-mono text-code text-fg">{entry.name}</span>
                  {confirming === entry.name ? (
                    <div
                      role="group"
                      aria-label={t("agentSafety.secrets.delete.label", { name: entry.name })}
                    >
                      <p className="text-ui text-attn">
                        {t("agentSafety.secrets.delete.ask", { name: entry.name })}
                      </p>
                      <div className="flex gap-s2">
                        <Button
                          variant="primary"
                          pendingSince={deleting.since}
                          onClick={() => remove(entry.name)}
                        >
                          {t("agentSafety.secrets.delete")}
                        </Button>
                        <Button onClick={() => setConfirming(null)}>{t("agentSafety.secrets.keep")}</Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <span className="text-label text-muted">
                        {t("agentSafety.secrets.saved", { date: date(entry.updatedAt) })}
                      </span>
                      <Button
                        size="sm"
                        aria-label={t("agentSafety.secrets.delete.label", { name: entry.name })}
                        onClick={() => setConfirming(entry.name)}
                      >
                        {t("agentSafety.secrets.delete")}
                      </Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-col gap-s2">
            <TextField
              label={t("agentSafety.secrets.name")}
              hint={t("agentSafety.secrets.name.hint")}
              value={name}
              autoComplete="off"
              disabled={adding.since !== null}
              onChange={(next) => {
                setName(next);
                setProblem(null);
              }}
            />
            <div className="flex flex-col gap-s1">
              <label htmlFor={valueId} className="label-hud text-muted">
                {t("agentSafety.secrets.value")}
              </label>
              <input
                id={valueId}
                ref={attach}
                type="password"
                autoComplete="off"
                spellCheck={false}
                disabled={adding.since !== null}
                onInput={() => setTyped(field.current?.value !== "")}
                className={FIELD_CLASSES}
              />
            </div>
            <div>
              <Button
                variant="primary"
                aria-describedby={problem === null ? undefined : problemId}
                disabled={name === "" || !typed}
                pendingSince={adding.since}
                onClick={add}
              >
                {t("agentSafety.secrets.add")}
              </Button>
            </div>
          </div>
        </>
      )}
      {problem !== null ? (
        <InlineError announce="action" id={problemId}>
          {t(problem)}
        </InlineError>
      ) : null}
    </section>
  );
}
