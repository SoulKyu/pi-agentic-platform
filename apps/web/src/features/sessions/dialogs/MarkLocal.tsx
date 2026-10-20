import type { TaintCause } from "@pap/contracts";
import { Button } from "@pap/ui";
import { useState } from "react";
import { useT } from "../../../i18n/index.ts";
import { getRuntime } from "../../../runtime/index.ts";
import "../register-policy-catalog.ts";
import { useAction } from "../use-action.ts";
import { markCausesLocal, rulesOf } from "./mark-local.ts";

/**
 * "Mark as local tool" on the card of a tainted session whose every cause is a tool the owner can declare local. The
 * confirmation says what the click allows. The pending question is not answered by this: it only stops the next result of
 * these tools from tainting, and lifts this session's mark.
 */
export function MarkLocal({
  sessionId,
  causes,
}: {
  readonly sessionId: string;
  readonly causes: readonly TaintCause[];
}) {
  const t = useT();
  const [asking, setAsking] = useState(false);
  const [done, setDone] = useState(false);
  const action = useAction();
  const rules = rulesOf(causes);
  const mark = async () => {
    const marked = await action.run(() => markCausesLocal(getRuntime().rpc, sessionId, causes));
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
        <p role="alert" className="w-full text-ui text-attn">
          {action.error}
        </p>
      )}
    </>
  );
}
