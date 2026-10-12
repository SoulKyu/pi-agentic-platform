import { Button } from "@pap/ui";
import { useEffect, useState } from "react";
import { t } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { failureText } from "./failure.ts";
import { useAction } from "./use-action.ts";

/** Rule labels can be long (the daemon keeps up to 4096 characters): the row shows the start. */
const LABEL_CODE_POINTS = 200;
const clipLabel = (label: string): string => {
  const points = [...label];
  return points.length > LABEL_CODE_POINTS ? `${points.slice(0, LABEL_CODE_POINTS).join("")}…` : label;
};

interface Rule {
  readonly id: string;
  readonly tool: string;
  readonly label: string;
  readonly createdAt: number;
}

const dayOf = (millis: number): string =>
  Number.isFinite(millis) && Math.abs(millis) <= 8.64e15 ? new Date(millis).toISOString().slice(0, 10) : "";

function RuleLine({ rule, onSettled }: { rule: Rule; onSettled: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const revoke = useAction((call) => call, setError);
  return (
    <li data-rule className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="font-mono text-label font-semibold text-fg">{rule.tool}</span>
        <span data-rule-label className="min-w-0 flex-1 break-all font-mono text-ui text-muted">
          {clipLabel(rule.label)}
        </span>
        <span className="font-mono text-label text-muted">{dayOf(rule.createdAt)}</span>
        <Button
          disabled={revoke.busy}
          onClick={() =>
            void revoke
              .run(() =>
                getRuntime().rpc.call(
                  "policy.revokeRule",
                  { ruleId: rule.id },
                  { commandId: getRuntime().rpc.newCommandId() },
                ),
              )
              // Whatever the outcome (a timeout included), the list is the truth: it is loaded again, never the call.
              .then(onSettled)
          }
        >
          {t("rules.revoke")}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-ui text-attention">
          {error}
        </p>
      ) : null}
    </li>
  );
}

/** The always-rules of a project (its git root, as the daemon resolves `cwd`), newest first, each revocable. */
export function AlwaysRules({ cwd }: { cwd: string }) {
  const [rules, setRules] = useState<readonly Rule[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped to list again; each run of the effect drops the answer of the one before it.
  const [loads, setLoads] = useState(0);
  useEffect(() => {
    let current = true;
    getRuntime()
      .rpc.call("policy.listRules", { cwd })
      .then(
        (answer) => {
          if (!current) return;
          setRules(answer.rules);
          setTruncated(answer.truncated);
          setError(null);
        },
        (failure: unknown) => {
          if (current) setError(failureText(failure));
        },
      );
    return () => {
      current = false;
    };
  }, [cwd, loads]);

  return (
    <div className="flex flex-col gap-2">
      {error ? (
        <p role="alert" className="text-ui text-attention">
          {error}
        </p>
      ) : null}
      {rules === null ? (
        error ? null : (
          <p className="text-ui text-muted">{t("rules.loading")}</p>
        )
      ) : rules.length === 0 ? (
        <p className="text-ui text-muted">{t("rules.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rules.map((rule) => (
            <RuleLine key={rule.id} rule={rule} onSettled={() => setLoads((count) => count + 1)} />
          ))}
        </ul>
      )}
      {truncated ? <p className="text-ui text-attention">{t("rules.more")}</p> : null}
    </div>
  );
}

/** The session header's disclosure: opened, it finds the session's folder and lists the rules of its project. */
export function SessionRules({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  const [cwd, setCwd] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || cwd !== null) return;
    let current = true;
    getRuntime()
      .rpc.call("sessions.list", {})
      .then(
        (result) => {
          if (!current) return;
          const found = result.sessions.find((session) => session.id === sessionId)?.cwd ?? null;
          setCwd(found);
          setError(found === null ? t("rules.notFound") : null);
        },
        (failure: unknown) => {
          if (current) setError(failureText(failure));
        },
      );
    return () => {
      current = false;
    };
  }, [open, cwd, sessionId]);

  return (
    <details data-always-rules className="text-ui" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer font-mono text-label uppercase tracking-label text-muted">
        {t("rules.title")}
      </summary>
      <div className="mt-2">
        {open && cwd !== null ? <AlwaysRules cwd={cwd} /> : null}
        {open && cwd === null ? (
          error ? (
            <p role="alert" className="text-ui text-attention">
              {error}
            </p>
          ) : (
            <p className="text-ui text-muted">{t("rules.loading")}</p>
          )
        ) : null}
      </div>
    </details>
  );
}
