import { LocalToolRule, MAX_LOCAL_TOOLS, ToolName } from "@pap/contracts";
import { Button, TextField } from "@pap/ui";
import { useState } from "react";
import { useT } from "../../i18n/index.ts";

const NOTE = "text-ui text-muted";

interface Draft {
  readonly tool: string;
  readonly source: string;
}

/** The tools the owner vouches for as local: a name and the registered source it must come from. */
export function LocalToolsField({
  rules,
  draft,
  onRules,
  onDraft,
}: {
  readonly rules: readonly LocalToolRule[];
  readonly draft: Draft;
  onRules(rules: readonly LocalToolRule[]): void;
  onDraft(draft: Draft): void;
}) {
  const t = useT();
  // An error shows only once its field was left.
  const [left, setLeft] = useState({ tool: false, source: false });
  const tool = draft.tool.trim();
  const source = draft.source.trim();
  const parsed = LocalToolRule.safeParse({ tool, source });
  const duplicate = rules.some((rule) => rule.tool === tool && rule.source === source);
  const full = rules.length >= MAX_LOCAL_TOOLS;
  const toolError =
    left.tool && tool !== "" && !ToolName.safeParse(tool).success ? t("approvals.local.invalidTool") : null;
  const sourceError =
    left.source && source !== "" && !LocalToolRule.shape.source.safeParse(source).success
      ? t("approvals.local.invalidSource")
      : parsed.success && duplicate
        ? t("approvals.local.duplicate")
        : parsed.success && full
          ? t("approvals.local.full", { max: MAX_LOCAL_TOOLS })
          : null;
  const add = () => {
    if (!parsed.success || duplicate || full) return;
    onRules([...rules, parsed.data]);
    onDraft({ tool: "", source: "" });
    setLeft({ tool: false, source: false });
  };
  return (
    <div className="flex flex-col gap-s2">
      <p className={NOTE}>{t("approvals.local.hint")}</p>
      <p className={NOTE}>{t("approvals.local.limits")}</p>
      {rules.length === 0 ? (
        <p className={NOTE}>{t("approvals.local.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-s1">
          {rules.map((rule) => (
            <li
              key={`${rule.tool}\n${rule.source}`}
              data-local-tool={rule.tool}
              className="flex items-center justify-between gap-s2"
            >
              <span className="min-w-0 break-all font-mono text-ui text-fg">
                {rule.tool} · {rule.source}
              </span>
              <Button
                variant="secondary"
                size="sm"
                aria-label={t("approvals.local.remove", { tool: rule.tool })}
                onClick={() => onRules(rules.filter((other) => other !== rule))}
              >
                {t("approvals.local.removeShort")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div onBlur={() => setLeft((now) => ({ ...now, tool: true }))}>
        <TextField
          label={t("approvals.local.tool")}
          value={draft.tool}
          onChange={(value) => onDraft({ ...draft, tool: value })}
          error={toolError}
        />
      </div>
      <div onBlur={() => setLeft((now) => ({ ...now, source: true }))}>
        <TextField
          label={t("approvals.local.source")}
          value={draft.source}
          onChange={(value) => onDraft({ ...draft, source: value })}
          error={sourceError}
        />
      </div>
      <div>
        <Button variant="secondary" disabled={!parsed.success || duplicate || full} onClick={add}>
          {t("approvals.local.add")}
        </Button>
      </div>
    </div>
  );
}
