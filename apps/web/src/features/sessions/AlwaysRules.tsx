import { Button, InlineError } from "@pap/ui";
import { useEffect, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { coverText } from "../../lib/rule-text.ts";
import { getRuntime } from "../../runtime/index.ts";
import { failureText } from "./failure.ts";
import "./register-policy-catalog.ts";
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
  readonly kind?: "exact" | "prefix" | "tool";
  readonly pattern?: readonly string[];
}

const dayOf = (millis: number): string =>
  Number.isFinite(millis) && Math.abs(millis) <= 8.64e15 ? new Date(millis).toISOString().slice(0, 10) : "";

function RuleLine({ rule, onSettled }: { rule: Rule; onSettled: () => void }) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const revoke = useAction((call) => call, setError);
  return (
    <li data-rule className="flex flex-col gap-s1">
      <div className="flex items-center gap-s2">
        <span className="font-mono text-label font-semibold text-fg">{rule.tool}</span>
        <span data-rule-label className="min-w-0 flex-1 break-all font-mono text-ui text-muted">
          {coverText(rule, t("sessionPolicy.rule.anyInput")) ?? clipLabel(rule.label)}
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
      {error ? <InlineError announce="action">{error}</InlineError> : null}
    </li>
  );
}

/** The always-rules of a project (its git root, as the daemon resolves `cwd`), newest first, each revocable. */
export function AlwaysRules({ cwd }: { cwd: string }) {
  const t = useT();
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
    <div className="flex flex-col gap-s2">
      {error ? <InlineError announce="background">{error}</InlineError> : null}
      {rules === null ? (
        error ? null : (
          <p className="text-ui text-muted">{t("rules.loading")}</p>
        )
      ) : rules.length === 0 ? (
        <p className="text-ui text-muted">{t("rules.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-s2">
          {rules.map((rule) => (
            <RuleLine key={rule.id} rule={rule} onSettled={() => setLoads((count) => count + 1)} />
          ))}
        </ul>
      )}
      {truncated ? <p className="text-ui text-muted">{t("rules.more")}</p> : null}
    </div>
  );
}
