import { Button, TextField } from "@pap/ui";
import { useEffect, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { coverText } from "../../lib/rule-text.ts";
import { getRuntime } from "../../runtime/index.ts";
import { failureText } from "./failure.ts";
import { clipLabel, dayOf, groupRules, plain, shortScope, type RuleRow } from "./policy-settings.vm.ts";

function RuleLine({
  rule,
  onStart,
  onFailed,
  onSettled,
}: {
  rule: RuleRow;
  onStart: () => void;
  onFailed: (message: string) => void;
  onSettled: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const label = coverText(rule, t("approvals.rules.anyInput")) ?? clipLabel(rule.label);
  const revoke = () => {
    if (busy) return;
    setBusy(true);
    onStart();
    const rpc = getRuntime().rpc;
    rpc
      .call("policy.revokeRule", { ruleId: rule.id }, { commandId: rpc.newCommandId() })
      .catch((failure: unknown) => onFailed(failureText(failure)))
      // Whatever the outcome (a timeout included), the list is the truth: it is loaded again, never the call.
      .finally(() => {
        setBusy(false);
        onSettled();
      });
  };
  return (
    <li data-rule data-rule-kind={rule.kind ?? "exact"} className="flex flex-col gap-s1">
      <div className="flex items-center gap-s2">
        <span className="font-mono text-label font-semibold text-fg">{plain(rule.tool)}</span>
        <span data-rule-label className="min-w-0 flex-1 break-all font-mono text-ui text-muted">
          {label}
        </span>
        <span className="font-mono text-label text-muted">{dayOf(rule.createdAt)}</span>
        <Button
          variant="secondary"
          disabled={busy}
          aria-label={t("approvals.rules.revokeOne", { tool: plain(rule.tool), label })}
          onClick={revoke}
        >
          {t("approvals.rules.revoke")}
        </Button>
      </div>
    </li>
  );
}

const matches = (rule: RuleRow, needle: string): boolean =>
  [rule.tool, rule.label, rule.scope].some((field) => plain(field).toLowerCase().includes(needle));

/** The always rules of every project (`policy.listRules {}`), grouped by project, each revocable (M5R91). */
export function RulesByProject() {
  const t = useT();
  const [rules, setRules] = useState<readonly RuleRow[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Kept here, not in the line: the reload may remove the rule, and the failure must stay on screen.
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  // Bumped to list again; each run of the effect drops the answer of the one before it.
  const [loads, setLoads] = useState(0);
  useEffect(() => {
    let current = true;
    getRuntime()
      .rpc.call("policy.listRules", {})
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
  }, [loads]);

  const needle = filter.trim().toLowerCase();
  const shown = rules === null ? [] : rules.filter((rule) => needle === "" || matches(rule, needle));
  return (
    <section className="flex flex-col gap-s3">
      <h3 className="text-ui font-semibold text-fg">{t("approvals.rules.title")}</h3>
      <p className="text-ui text-muted">{t("approvals.rules.hint")}</p>
      {error ? (
        <p role="alert" className="text-ui text-attn">
          {error}
        </p>
      ) : null}
      {revokeError ? (
        <p role="alert" className="text-ui text-attn">
          {revokeError}
        </p>
      ) : null}
      {rules === null ? (
        error ? null : (
          <p className="text-ui text-muted">{t("approvals.rules.loading")}</p>
        )
      ) : rules.length === 0 ? (
        <p className="text-ui text-muted">{t("approvals.rules.empty")}</p>
      ) : (
        <>
          <TextField label={t("approvals.rules.filter")} value={filter} onChange={setFilter} />
          {shown.length === 0 ? <p className="text-ui text-muted">{t("approvals.rules.noMatch")}</p> : null}
          {groupRules(shown).map((group) => (
            <div
              key={group.scope}
              role="group"
              data-rule-group
              aria-label={t("approvals.rules.group", { path: plain(group.scope) })}
              className="flex flex-col gap-s2"
            >
              <div className="flex items-baseline justify-between gap-s2">
                <span className="break-all font-mono text-label font-semibold text-fg">
                  {shortScope(group.scope) || t("approvals.rules.noScope")}
                </span>
                <span className="font-mono text-label text-muted">
                  {t("approvals.rules.count", { count: group.rules.length })}
                </span>
              </div>
              <ul className="flex flex-col gap-s2">
                {group.rules.map((rule) => (
                  <RuleLine
                    key={rule.id}
                    rule={rule}
                    onStart={() => setRevokeError(null)}
                    onFailed={setRevokeError}
                    onSettled={() => setLoads((count) => count + 1)}
                  />
                ))}
              </ul>
            </div>
          ))}
        </>
      )}
      {truncated ? (
        <p role="status" className="text-ui text-attn">
          {t("approvals.rules.more")}
        </p>
      ) : null}
    </section>
  );
}
