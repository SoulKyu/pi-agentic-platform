import { AUTOMATION_LIMITS, AutomationSettings, TimeZone } from "@pap/contracts";

/** What the person typed, as text, until it is checked. */
export interface Draft {
  readonly slots: string;
  readonly from: string;
  readonly to: string;
  readonly budget: string;
  readonly autoResume: boolean;
}

type Saved = Pick<AutomationSettings, "slots" | "quietHours" | "dailyBudgetUsd" | "autoResume">;

export interface Checked {
  readonly slots: boolean;
  readonly quiet: boolean;
  readonly budget: boolean;
  /** Both times are valid and equal: the form says there is no window. */
  readonly noWindow: boolean;
  /** The values to save; null while any field is refused. */
  readonly value: Saved | null;
}

export const draftOf = (settings: AutomationSettings): Draft => ({
  slots: String(settings.slots),
  from: settings.quietHours?.from ?? "",
  to: settings.quietHours?.to ?? "",
  budget: settings.dailyBudgetUsd === null ? "" : String(settings.dailyBudgetUsd),
  autoResume: settings.autoResume,
});

const HHMM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const MONEY = /^\d{1,4}(?:\.\d{1,4})?$/;
const MAX_BUDGET = 1000;

export function check(draft: Draft): Checked {
  const { min, max } = AUTOMATION_LIMITS.slots;
  const slots = Number(draft.slots.trim());
  const slotsOk = /^\d{1,2}$/.test(draft.slots.trim()) && slots >= min && slots <= max;
  const from = draft.from.trim();
  const to = draft.to.trim();
  const quietOk = (from === "" && to === "") || (HHMM.test(from) && HHMM.test(to));
  const text = draft.budget.trim().replace(",", ".");
  const budget = text === "" ? null : Number(text);
  const budgetOk = text === "" || (MONEY.test(text) && budget !== null && budget <= MAX_BUDGET);
  const quietHours = from === "" ? null : { from, to };
  return {
    slots: !slotsOk,
    quiet: !quietOk,
    budget: !budgetOk,
    noWindow: quietOk && from !== "" && from === to,
    value:
      slotsOk && quietOk && budgetOk
        ? { slots, quietHours, dailyBudgetUsd: budget, autoResume: draft.autoResume }
        : null,
  };
}

/** The browser's own zone when it is one the server accepts; null otherwise. */
export function browserZone(): string | null {
  try {
    const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    return TimeZone.safeParse(zone).success ? zone : null;
  } catch {
    return null;
  }
}
