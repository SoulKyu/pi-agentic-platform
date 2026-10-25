import type { Role } from "@pap/contracts";
import type { SettingsMembers, SettingsPort } from "./modules/settings/index.ts";
import type { RunsPort, RunsService } from "./modules/runs/index.ts";
import type { RelayLink } from "./modules/agent-vm/index.ts";
import type { BoxesLate } from "./compose-boxes.ts";

/** The install's default cap of a member, used when a member row has no budget (it fails closed, never unlimited). */
const FALLBACK_MEMBER_BUDGET_USD = 5;

interface BudgetAuth {
  ownerId(): string | null;
  roleOf(userId: string): Role | null;
  budgetOf(userId: string): number | null;
  isDisabled(userId: string): boolean;
}

/** A member's daily cap in USD (`users.budget_usd`); null for the owner. A row that is not a member's has no cap line. */
export function memberCapOf(auth: BudgetAuth): (userId: string) => number | null {
  return (userId) =>
    auth.roleOf(userId) === "member" ? (auth.budgetOf(userId) ?? FALLBACK_MEMBER_BUDGET_USD) : null;
}

/** What the settings clamp reads of the users. */
export const settingsMembersOf = (auth: BudgetAuth): SettingsMembers => ({
  capOf: memberCapOf(auth),
  ownerId: auth.ownerId,
  disabled: auth.isDisabled,
});

/** The member line (M14 OQ1, RT-02): what a member has cost the owner today, against `users.budget_usd`. */
export interface MemberLine {
  /** Today's cost of every run of the user billed `api` or `unknown`, in the OWNER's time zone. */
  memberSpentToday(userId: string): number;
  /** The account is disabled: its boxes are `paused` for the relay and its launches are refused (M14 RT-03). */
  disabled(userId: string): boolean;
  /** True for a member whose line has reached their cap; always false for the owner. */
  over(userId: string): boolean;
}

export function composeMemberLine(deps: {
  readonly auth: BudgetAuth;
  readonly runs: Pick<RunsService, "bindBudgetZone"> & { readonly port: Pick<RunsPort, "memberSpent"> };
  readonly settings: Pick<SettingsPort, "automation">;
}): MemberLine {
  const capOf = memberCapOf(deps.auth);
  const ownerZone = (fallback: string | null): string | null => {
    const ownerId = deps.auth.ownerId();
    return ownerId === null ? fallback : deps.settings.automation(ownerId).timezone;
  };
  // R10: the budget day of a member's runs is read in the owner's zone, whatever zone the caller of a gate passes.
  deps.runs.bindBudgetZone((userId, timeZone) =>
    deps.auth.roleOf(userId) === "member" ? ownerZone(timeZone) : timeZone,
  );
  const memberSpentToday = (userId: string): number => deps.runs.port.memberSpent(userId, ownerZone(null));
  return {
    memberSpentToday,
    disabled: deps.auth.isDisabled,
    over(userId) {
      const cap = capOf(userId);
      return cap !== null && memberSpentToday(userId) >= cap;
    },
  };
}

/**
 * A run ended (RT-02): the box it ran in gets a fresh policy, a project's as well as an agent's (the 60 s tick is too late
 * for a member chatting), and once the member is over their cap every box of theirs does, since the line is shared.
 */
export function refreshAfterRun(
  deps: {
    readonly relay: Pick<RelayLink, "refresh" | "refreshAll">;
    readonly memberLine: Pick<MemberLine, "over">;
    readonly boxes: BoxesLate["source"] | undefined;
    cwdOf?(ownerId: string, sessionId: string): string | null;
  },
  event: { readonly sessionId: string; readonly ownerId: string },
): void {
  const cwd = deps.cwdOf?.(event.ownerId, event.sessionId) ?? null;
  const project = cwd === null ? null : (deps.boxes?.byPath(event.ownerId, cwd) ?? null);
  if (project !== null) deps.relay.refresh({ kind: "project", id: project.projectId });
  if (deps.memberLine.over(event.ownerId)) deps.relay.refreshAll();
}
