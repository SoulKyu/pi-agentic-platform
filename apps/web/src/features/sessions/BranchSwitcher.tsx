import { Button } from "@pap/ui";
import { t } from "../../i18n/index.ts";
import type { BranchChoices } from "./branches.vm.ts";

interface BranchSwitcherProps {
  readonly choices: BranchChoices;
  /** True while the agent works or another structural call is in flight: both arrows wait. */
  readonly disabled: boolean;
  readonly onGo: (target: string) => void;
}

/** "‹ 2/3 ›": steps to the neighbour branch of a user message. */
export function BranchSwitcher({ choices, disabled, onGo }: BranchSwitcherProps) {
  const { previous, next } = choices;
  return (
    <div data-branch-switcher className="flex items-center gap-1">
      <Button
        aria-label={t("branch.previous")}
        disabled={disabled || previous === undefined}
        onClick={() => previous !== undefined && onGo(previous)}
      >
        ‹
      </Button>
      <span className="font-mono text-label text-muted">
        {t("branch.position", { index: choices.index, total: choices.total })}
      </span>
      <Button
        aria-label={t("branch.next")}
        disabled={disabled || next === undefined}
        onClick={() => next !== undefined && onGo(next)}
      >
        ›
      </Button>
    </div>
  );
}
