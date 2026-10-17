import { Button, TextField } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import { clearBudget, type Draft, type FormErrors } from "./agent-form.vm.ts";

interface Props {
  readonly draft: Draft;
  readonly errors: FormErrors;
  set(patch: Partial<Draft>): void;
}

/** The agent's own daily budget (owner m14): each half empty by default ("No budget") and cleared with one click. */
export function BudgetFields({ draft, errors, set }: Props) {
  const t = useT();
  const half = (which: "usd" | "tokens") => {
    const label = t(which === "usd" ? "agentForm.budget.usd" : "agentForm.budget.tokens");
    const error = errors[which === "usd" ? "budget.usdPerDay" : "budget.tokensPerDay"];
    return (
      <div className="flex items-end gap-s1">
        <div className="min-w-0 flex-1">
          <TextField
            label={label}
            value={draft[which]}
            placeholder={t("agentForm.budget.none")}
            error={error === undefined ? null : t(error)}
            onChange={(value) => set({ [which]: value })}
          />
        </div>
        <Button
          size="sm"
          aria-label={t("agentForm.budget.clearField", { field: label })}
          disabled={draft[which] === ""}
          onClick={() => set(clearBudget(draft, which))}
        >
          {t("agentForm.budget.clear")}
        </Button>
      </div>
    );
  };
  return (
    <fieldset data-slot="agent-budget" className="flex min-w-0 flex-col gap-s2">
      <legend className="label-hud text-muted">{t("agentForm.budget")}</legend>
      {half("usd")}
      {half("tokens")}
      <p className="text-ui text-muted">{t("agentForm.budget.hint")}</p>
    </fieldset>
  );
}
