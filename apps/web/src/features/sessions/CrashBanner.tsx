import { Banner, Button } from "@pap/ui";
import { useState } from "react";
import { useLocale, useT } from "../../i18n/index.ts";
import { codedServerText } from "../../i18n/server-text.ts";
import { getRuntime } from "../../runtime/index.ts";
import type { SessionView } from "../../stores/session-reducer.ts";
import { failureText } from "./failure.ts";

/** DESIGN.md §9.1: why the worker stopped, what is intact, and the one thing to do. Retry reopens the worker. */
export function CrashBanner({
  sessionId,
  crash,
}: {
  sessionId: string;
  crash: NonNullable<SessionView["crash"]>;
}) {
  const t = useT();
  const locale = useLocale();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const retry = () => {
    const rpc = getRuntime().rpc;
    setPending(true);
    setError(null);
    rpc
      .call("sessions.reopen", { sessionId }, { commandId: rpc.newCommandId() })
      .catch((failure: unknown) => setError(failureText(failure)))
      .finally(() => setPending(false));
  };
  const params = Object.entries(crash.params ?? {});
  return (
    <Banner
      tone="crash"
      title={t("session.crash.title")}
      actions={
        <Button variant="primary" size="sm" disabled={pending} onClick={retry}>
          {pending ? t("session.crash.retrying") : t("session.crash.retry")}
        </Button>
      }
    >
      <p data-crash-cause>{codedServerText(crash, locale)}</p>
      <p>{t("session.crash.intact")}</p>
      {error ? (
        <p data-crash-error className="text-attn">
          {error}
        </p>
      ) : null}
      <details data-crash-details className="mt-s1">
        <summary className="cursor-pointer label-hud">{t("session.crash.details")}</summary>
        <ul className="mt-s1 flex flex-col gap-s1 font-mono text-code">
          {crash.code ? <li>{t("session.crash.code", { code: crash.code })}</li> : null}
          {params.map(([name, value]) => (
            <li key={name}>{t("session.crash.params", { name, value })}</li>
          ))}
          <li>{t("session.crash.log")}</li>
        </ul>
      </details>
    </Banner>
  );
}
