import type { LocalToolRule } from "@pap/contracts";
import { Button, InlineError } from "@pap/ui";
import { useState } from "react";
import { useT } from "../../../i18n/index.ts";
import { getRuntime } from "../../../runtime/index.ts";
import "../register-policy-catalog.ts";
import { useAction } from "../use-action.ts";
import { markLocal } from "./mark-local.ts";

/**
 * "Mark as local tool" on a card that names tools the owner can declare local: every cause of the session's taint, the
 * asked extension tool of unknown kind (decision 143), or both. The confirmation says what the click allows. The pending
 * question is not answered by this: it stops the next calls of these tools from asking and their results from tainting,
 * and lifts this session's mark when `clearsMark` (the rules cover its every cause).
 */
export function MarkLocal({
  sessionId,
  rules,
  clearsMark,
}: {
  readonly sessionId: string;
  readonly rules: readonly LocalToolRule[];
  readonly clearsMark: boolean;
}) {
  const t = useT();
  const [asking, setAsking] = useState(false);
  const [done, setDone] = useState(false);
  const action = useAction();
  const mark = async () => {
    const marked = await action.run(() => markLocal(getRuntime().rpc, sessionId, rules, clearsMark));
    if (!marked) return;
    setAsking(false);
    setDone(true);
  };
  return (
    <>
      {asking || done ? null : (
        <Button size="sm" onClick={() => setAsking(true)}>
          {t("sessionPolicy.markLocal.button")}
        </Button>
      )}
      {asking ? (
        <div
          role="group"
          aria-label={t("sessionPolicy.markLocal.question")}
          data-inline-edit
          className="flex w-full flex-col items-start gap-s2"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            setAsking(false);
          }}
        >
          <p className="text-ui text-fg">
            {t("sessionPolicy.markLocal.body", { tools: rules.map((rule) => rule.tool).join(", ") })}
            {clearsMark ? ` ${t("sessionPolicy.markLocal.clears")}` : null}
          </p>
          <ul className="flex flex-col gap-s1 break-all font-mono text-ui text-fg">
            {rules.map((rule) => (
              <li key={`${rule.tool}\n${rule.source}`}>
                {t("sessionPolicy.markLocal.item", { tool: rule.tool, source: rule.source })}
              </li>
            ))}
          </ul>
          <div className="flex gap-s2">
            <Button variant="primary" size="sm" disabled={action.busy} onClick={() => void mark()}>
              {t("sessionPolicy.markLocal.confirm")}
            </Button>
            <Button size="sm" disabled={action.busy} onClick={() => setAsking(false)}>
              {t("sessionPolicy.cancel")}
            </Button>
          </div>
        </div>
      ) : null}
      {done ? (
        <p role="status" className="text-ui text-muted">
          {t("sessionPolicy.markLocal.done")}
        </p>
      ) : null}
      {action.error === null ? null : (
        <div className="w-full">
          <InlineError announce="action">{action.error}</InlineError>
        </div>
      )}
    </>
  );
}
