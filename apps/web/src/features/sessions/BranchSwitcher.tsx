import { IconChevronLeft, IconChevronRight, MessageAction } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import type { BranchChoices } from "./branches.vm.ts";

interface BranchSwitcherProps {
  readonly choices: BranchChoices;
  /** True while the agent works or another structural call is in flight: both arrows wait. */
  readonly disabled: boolean;
  /** Steps to the neighbour branch; `index` is the 1-based place the row will have there. */
  readonly onGo: (target: string, index: number) => void;
}

/** "‹ 2/3 ›": steps to the neighbour branch of a user message. The group is named with the position, which is also announced after a step. */
export function BranchSwitcher({ choices, disabled, onGo }: BranchSwitcherProps) {
  const t = useT();
  const { previous, next } = choices;
  return (
    <div
      role="group"
      aria-label={t("branch.group", { index: choices.index, total: choices.total })}
      data-branch-switcher
      className="flex items-center gap-s1"
    >
      <MessageAction
        label={t("branch.previous")}
        icon={IconChevronLeft}
        disabled={disabled || previous === undefined}
        onClick={() => previous !== undefined && onGo(previous, choices.index - 1)}
      />
      <span aria-hidden="true" className="font-mono text-label tabular-nums text-muted">
        {t("branch.position", { index: choices.index, total: choices.total })}
      </span>
      <MessageAction
        label={t("branch.next")}
        icon={IconChevronRight}
        disabled={disabled || next === undefined}
        onClick={() => next !== undefined && onGo(next, choices.index + 1)}
      />
    </div>
  );
}
