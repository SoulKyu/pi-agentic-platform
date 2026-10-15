import type { TaskFailure } from "@pap/contracts";
import { Banner, Button } from "@pap/ui";
import { useState } from "react";
import { formatAge } from "../../i18n/age.ts";
import { plural, useLocale, useT } from "../../i18n/index.ts";
import { getRuntime, RpcError } from "../../runtime/index.ts";
import { actionErrorText, shown } from "./board.vm.ts";

/** Outbox jobs that gave up (this owner's and the system's, M10R148): a neutral banner with one row each and Dismiss. */
export function FailuresBanner({
  failures,
  now,
}: {
  readonly failures: readonly TaskFailure[];
  readonly now: number;
}) {
  const t = useT();
  const locale = useLocale();
  const [dismissing, setDismissing] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (failures.length === 0) return null;

  const dismiss = (effectId: number) => {
    if (dismissing !== null) return;
    setDismissing(effectId);
    setError(null);
    const rpc = getRuntime().rpc;
    rpc
      .call("automation.failures.dismiss", { effectId }, { commandId: rpc.newCommandId() })
      .catch((failure: unknown) =>
        setError(actionErrorText("dismiss", failure instanceof RpcError ? failure.code : "internal")),
      )
      .finally(() => setDismissing(null));
  };

  return (
    <Banner tone="capacity" title={plural(locale, "automation.failures.title", failures.length)}>
      <ul className="flex flex-col gap-s1">
        {failures.map((failure) => (
          <li key={failure.id} className="flex flex-wrap items-center justify-between gap-s2">
            <span className="min-w-0 break-words font-mono text-label tabular-nums">
              {t("automation.failures.row", {
                kind: shown(failure.kind, "code"),
                age: formatAge(now, failure.settledAt, t),
                code:
                  failure.lastError === null
                    ? t("automation.failures.noCode")
                    : shown(failure.lastError, "code"),
              })}
            </span>
            <Button size="sm" disabled={dismissing !== null} onClick={() => dismiss(failure.id)}>
              {t("ui.dismiss")}
            </Button>
          </li>
        ))}
      </ul>
      {error ? (
        <p role="alert" className="text-ui text-err">
          {error}
        </p>
      ) : null}
    </Banner>
  );
}
