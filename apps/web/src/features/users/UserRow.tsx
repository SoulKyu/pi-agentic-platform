import { USERS_LIMITS, type UserView } from "@pap/contracts";
import { Button, Chip, TextField } from "@pap/ui";
import { useState } from "react";
import { useLocale, useT } from "../../i18n/index.ts";
import type { StepUpRunner } from "../../lib/step-up-context.tsx";
import { getRuntime } from "../../runtime/index.ts";
import { formatUsd, whenText } from "./format.ts";
import { DeleteUserDialog } from "./DeleteUserDialog.tsx";
import { useUserAction } from "./use-users.ts";

interface Props {
  readonly user: UserView;
  readonly stepUp: StepUpRunner;
  onChanged(): void;
}

const parseBudget = (raw: string): number | null => {
  const value = Number(raw.replace(",", "."));
  return /^\d+([.,]\d+)?$/.test(raw.trim()) && value >= 0 && value <= USERS_LIMITS.budgetMaxUsd
    ? value
    : null;
};

/**
 * One account: role and state chips, the spend line (`err` only once the spend reached the budget), and for a member the
 * budget, Disable or Enable (the step-up) and Delete. The owner has none of them and no cap.
 */
export function UserRow({ user, stepUp, onChanged }: Props) {
  const t = useT();
  const locale = useLocale();
  const owner = user.role === "owner";
  const [budget, setBudget] = useState(user.budgetUsd === null ? "" : String(user.budgetUsd));
  const [invalid, setInvalid] = useState(false);
  const [saved, setSaved] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const save = useUserAction();
  const toggle = useUserAction();

  const saveBudget = () => {
    const value = parseBudget(budget);
    setInvalid(value === null);
    setSaved(false);
    if (value === null) return;
    save.run(async () => {
      await getRuntime().rpc.call("users.setBudget", { userId: user.id, dailyBudgetUsd: value });
      setSaved(true);
      onChanged();
    });
  };
  const setDisabled = (disabled: boolean) =>
    toggle.run(async () => {
      const { rpc } = getRuntime();
      const params = { userId: user.id, disabled };
      const done = disabled
        ? await rpc.call("users.setDisabled", params)
        : await stepUp((commandId) => rpc.call("users.setDisabled", params, { commandId }));
      if (done !== null) onChanged();
    });

  const spent = formatUsd(user.spentTodayUsd, locale);
  const spent7 = formatUsd(user.spent7dUsd, locale);
  const reached = user.budgetUsd !== null && user.spentTodayUsd > 0 && user.spentTodayUsd >= user.budgetUsd;
  const boxes = t(user.boxesRunning === 1 ? "users.row.boxesOne" : "users.row.boxes", {
    n: user.boxesRunning,
  });
  const problem = save.problem ?? toggle.problem;
  return (
    <li data-user={user.id} className="flex flex-col gap-s2 border-b border-border py-s2">
      <div className="flex flex-wrap items-center gap-s2">
        <span className={`text-ui font-semibold ${user.disabled ? "text-muted" : "text-fg"}`}>
          {user.username}
        </span>
        <Chip tone="mut" label={t(`shell.role.${user.role}`)} />
        {user.disabled ? <Chip tone="mut" label={t("users.disabled")} /> : null}
        <span className="flex-1" />
        {owner ? null : (
          <>
            <Button
              variant="secondary"
              pendingSince={toggle.since}
              onClick={() => setDisabled(!user.disabled)}
            >
              {t(user.disabled ? "users.enable" : "users.disable")}
            </Button>
            <Button variant="secondary" onClick={() => setDeleting(true)}>
              {t("users.delete")}
            </Button>
          </>
        )}
      </div>
      <p className="text-label text-muted">
        {t("users.row.meta", {
          date: whenText(user.createdAt, locale),
          when: user.lastSeenAt === null ? t("users.row.never") : whenText(user.lastSeenAt, locale),
        })}
      </p>
      <p data-spend="" className={`text-label ${reached ? "text-err" : "text-muted"}`}>
        {user.budgetUsd === null
          ? t("users.row.spendOwner", { spent, spent7 })
          : t("users.row.spend", { spent, budget: formatUsd(user.budgetUsd, locale), spent7 })}{" "}
        · {boxes}
      </p>
      {owner ? null : (
        <div className="flex flex-wrap items-end gap-s2">
          <TextField
            label={t("users.budget")}
            value={budget}
            onChange={(value) => {
              setBudget(value);
              setInvalid(false);
              setSaved(false);
            }}
            numeric
            ground="surface"
            error={invalid ? t("users.budget.invalid", { max: USERS_LIMITS.budgetMaxUsd }) : null}
          />
          <Button variant="secondary" pendingSince={save.since} onClick={saveBudget}>
            {t("users.budget.save")}
          </Button>
          {saved ? (
            <span role="status" className="text-ui text-muted">
              {t("users.budget.saved")}
            </span>
          ) : null}
        </div>
      )}
      {problem === null ? null : (
        <p role="status" className="text-ui text-err">
          {t(problem)}
        </p>
      )}
      {deleting ? (
        <DeleteUserDialog
          user={user}
          stepUp={stepUp}
          onClose={() => setDeleting(false)}
          onDeleted={() => {
            setDeleting(false);
            onChanged();
          }}
        />
      ) : null}
    </li>
  );
}
