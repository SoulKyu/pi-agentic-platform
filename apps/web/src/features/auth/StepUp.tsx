import { Button, TextField } from "@pap/ui";
import { Dialog } from "@pap/ui/overlays";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { errorKey, t as tNow, useT } from "../../i18n/index.ts";
import { confirmPassword, type ConfirmResult } from "./auth-api.ts";

type Refusal = Extract<ConfirmResult, { ok: false }>;

const refusalText = (refusal: Refusal): string =>
  refusal.code === "rate_limited"
    ? tNow("login.throttled", { seconds: refusal.retryAfterSeconds ?? 1 })
    : tNow(errorKey(refusal.code === "network" ? "offline" : refusal.code));

function StepUpPrompt({ onDone, onSignedOut }: { onDone(confirmed: boolean): void; onSignedOut(): void }) {
  const t = useT();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A confirm that answers after the prompt closed (Escape, unmount) is dropped.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const submit = () => {
    if (busy || password === "") return;
    const secret = password;
    // The field is empty from here on, whatever the answer: the password is not kept in state after use.
    setPassword("");
    setBusy(true);
    setError(null);
    void confirmPassword(secret).then((result) => {
      if (!alive.current) return;
      setBusy(false);
      if (result.ok) onDone(true);
      else if (result.code === "unauthenticated") {
        onDone(false);
        onSignedOut();
      } else setError(refusalText(result));
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onDone(false);
      }}
      title={t("access.stepUp.title")}
      description={t("access.stepUp.description")}
      closeLabel={t("access.close")}
    >
      <form
        className="flex flex-col gap-s3 p-s3"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <TextField
          label={t("setup.password")}
          value={password}
          onChange={setPassword}
          type="password"
          name="password"
          autoComplete="current-password"
          error={error}
          disabled={busy}
        />
        <div className="flex justify-end gap-s2">
          <Button onClick={() => onDone(false)}>{t("account.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={busy || password === ""}>
            {t("access.stepUp.confirm")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * `ask()` opens the password prompt and answers whether the person confirmed (M5R94). One prompt at a time: a
 * second `ask()` while one is open answers false. A prompt still open when the screen goes away answers false.
 */
export function useStepUp(onSignedOut: () => void): { ask(): Promise<boolean>; prompt: ReactNode } {
  const [open, setOpen] = useState(false);
  const waiting = useRef<((confirmed: boolean) => void) | null>(null);
  const finish = useCallback((confirmed: boolean) => {
    const resolve = waiting.current;
    waiting.current = null;
    setOpen(false);
    resolve?.(confirmed);
  }, []);
  const ask = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        if (waiting.current) {
          resolve(false);
          return;
        }
        waiting.current = resolve;
        setOpen(true);
      }),
    [],
  );
  useEffect(
    () => () => {
      waiting.current?.(false);
      waiting.current = null;
    },
    [],
  );
  return { ask, prompt: open ? <StepUpPrompt onDone={finish} onSignedOut={onSignedOut} /> : null };
}
