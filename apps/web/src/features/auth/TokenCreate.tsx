import { TOKEN_LIFETIMES_DAYS, TOKEN_PERMISSIONS, type TokenView } from "@pap/contracts";
import { Button, Checkbox, InlineError, Segmented, TextField, copyText } from "@pap/ui";
import { useEffect, useId, useRef, useState } from "react";
import { useT, type MessageKey } from "../../i18n/index.ts";
import { getRuntime, RpcError } from "../../runtime/index.ts";
import { useStepUp } from "./StepUp.tsx";
import { withStepUp } from "./step-up.ts";
import { permissionGrid, riskyPermissions, type RiskyPermission } from "./tokens.vm.ts";

const RISK_NOTES: Record<RiskyPermission, MessageKey> = {
  "sessions:operate": "access.tokens.riskNote",
  "files:operate": "access.tokens.riskNote.filesOperate",
  "files:read": "access.tokens.riskNote.filesRead",
  "automation:operate": "access.tokens.riskNote.automationOperate",
};
import { useMutation } from "./use-mutation.ts";
import { useRole } from "../../lib/role-context.ts";

const GRIDS = { owner: permissionGrid(undefined, "owner"), member: permissionGrid(undefined, "member") };
const DAYS = TOKEN_LIFETIMES_DAYS.map(String);
const NAME_MAX = 64;
const FIELD =
  "w-full rounded-sm border border-control-border bg-bg px-s2 py-s1 font-mono text-ui text-fg focus-ring pointer-coarse:min-h-11 pointer-coarse:text-base";

type Created = { readonly token: TokenView; readonly value: string };

/** Null when the person cancelled the password prompt (a choice, not an error), `"lost"` when the value cannot be shown. */
async function createToken(
  params: { name: string; permissions: TokenView["permissions"]; expiresInDays: 7 | 30 | 90 | 365 },
  ask: () => Promise<boolean>,
): Promise<Created | "lost" | "unknown" | null> {
  const rpc = getRuntime().rpc;
  let cancelled = false;
  try {
    return await withStepUp(
      (commandId) => rpc.call("auth.tokens.create", params, { commandId }),
      async () => {
        const confirmed = await ask();
        cancelled = !confirmed;
        return confirmed;
      },
      rpc.newCommandId(),
    );
  } catch (failure) {
    if (cancelled) return null;
    // A replayed commandId answers `conflict` and the value exists in the first response only (M5R68).
    if (failure instanceof RpcError && failure.code === "conflict") return "lost";
    // Outcome unknown (R105): never retried; the list shows whether the token exists.
    if (failure instanceof RpcError && (failure.code === "timeout" || failure.code === "connection_lost"))
      return "unknown";
    throw failure;
  }
}

/** The value of a new token: shown once, read-only, until Done (or the screen going away) drops it. */
function TokenValue({ created, onDone }: { readonly created: Created; onDone(): void }) {
  const t = useT();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  return (
    <div role="group" aria-label={t("access.tokens.created")} className="flex w-full flex-col gap-s2">
      <p role="status" className="text-ui text-fg">
        {t("access.tokens.created")}. {t("access.tokens.shownOnce")}
      </p>
      <label htmlFor={id} className="label-hud text-muted">
        {t("access.tokens.value")}
      </label>
      <input
        ref={input}
        id={id}
        readOnly
        value={created.value}
        autoComplete="off"
        spellCheck={false}
        className={FIELD}
        onFocus={(event) => event.currentTarget.select()}
      />
      <div className="flex flex-wrap items-center gap-s2">
        <Button
          variant="secondary"
          onClick={() => {
            void copyText(created.value).then((ok) => setCopy(ok ? "copied" : "failed"));
          }}
        >
          {t("access.tokens.copy")}
        </Button>
        <Button variant="primary" onClick={onDone}>
          {t("access.tokens.done")}
        </Button>
        {copy === "copied" ? (
          <span role="status" className="text-ui text-muted">
            {t("access.tokens.copied")}
          </span>
        ) : null}
        {copy === "failed" ? (
          <InlineError announce="action">{t("access.tokens.copyFailed")}</InlineError>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Create form for an API token (M5R97/M5R98): name, lifetime, permissions from `TOKEN_PERMISSIONS`. The create runs
 * behind a step-up. The value lives in this component's state until Done; `onCreated` carries no value.
 */
export function TokenCreate({ onCreated, onSignedOut }: { onCreated(): void; onSignedOut(): void }) {
  const t = useT();
  const grid = GRIDS[useRole()];
  const { busy, error, run } = useMutation(onCreated);
  const stepUp = useStepUp(onSignedOut);
  const [name, setName] = useState("");
  const [days, setDays] = useState("90");
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [created, setCreated] = useState<Created | null>(null);
  const [notice, setNotice] = useState<"lost" | "unknown" | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const refocus = useRef(false);
  // After Done the form is back: focus returns to its first field.
  useEffect(() => {
    if (created || !refocus.current) return;
    refocus.current = false;
    form.current?.querySelector("input")?.focus();
  }, [created]);

  const trimmed = name.trim();
  const valid = trimmed.length >= 1 && trimmed.length <= NAME_MAX && selected.length > 0;
  const toggle = (permission: string, on: boolean) =>
    setSelected((list) => (on ? [...list, permission] : list.filter((entry) => entry !== permission)));

  const submit = () => {
    if (!valid) return;
    setNotice(null);
    const permissions = TOKEN_PERMISSIONS.filter((permission) => selected.includes(permission));
    const params = { name: trimmed, permissions, expiresInDays: Number(days) as 7 | 30 | 90 | 365 };
    run(async () => {
      const answer = await createToken(params, stepUp.ask);
      if (answer === "lost" || answer === "unknown") setNotice(answer);
      else if (answer !== null) {
        setCreated(answer);
        setName("");
        setSelected([]);
      }
    });
  };

  if (created)
    return (
      <TokenValue
        created={created}
        onDone={() => {
          refocus.current = true;
          setCreated(null);
        }}
      />
    );

  return (
    <>
      <form
        ref={form}
        className="flex w-full flex-col gap-s3"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <TextField
          label={t("access.tokens.name")}
          hint={t("access.tokens.nameHint")}
          value={name}
          onChange={setName}
          autoComplete="off"
          disabled={busy}
        />
        <Segmented
          label={t("access.tokens.lifetime")}
          value={days}
          options={DAYS.map((value) => ({ value, label: t("access.tokens.days", { count: value }) }))}
          onChange={setDays}
        />
        <fieldset className="flex flex-col gap-s2">
          <legend className="label-hud text-muted">{t("access.tokens.permissions")}</legend>
          {grid.map((row) => (
            <div
              key={row.domain}
              role="group"
              aria-label={t(`access.tokens.domain.${row.domain}` as MessageKey)}
              className="flex flex-wrap items-center gap-x-s4 gap-y-s1"
            >
              <span className="w-40 text-ui text-fg">
                {t(`access.tokens.domain.${row.domain}` as MessageKey)}
              </span>
              {row.levels.map((level) => (
                <div key={level.permission} data-permission={level.permission}>
                  <Checkbox
                    label={t(`access.tokens.level.${level.label}` as MessageKey)}
                    checked={selected.includes(level.permission)}
                    onChange={(on) => toggle(level.permission, on)}
                    disabled={busy}
                  />
                </div>
              ))}
            </div>
          ))}
          <p className="text-ui text-muted">{t("access.tokens.policyNote")}</p>
          {riskyPermissions(selected).map((permission) => (
            <p key={permission} role="status" className="text-ui text-attn">
              {t(RISK_NOTES[permission])}
            </p>
          ))}
        </fieldset>
        {notice ? (
          <InlineError announce="action">
            {t(notice === "lost" ? "access.tokens.lost" : "access.tokens.unknown")}
          </InlineError>
        ) : null}
        {error ? <InlineError announce="action">{error}</InlineError> : null}
        <div>
          <Button type="submit" variant="primary" disabled={busy || !valid}>
            {t("access.tokens.create")}
          </Button>
        </div>
      </form>
      {stepUp.prompt}
    </>
  );
}
