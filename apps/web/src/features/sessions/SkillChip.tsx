import { Button } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import "./register-models-catalog.ts";

/** The skill the message starts with (`/skill:<name> `), shown as a `$name` chip; × takes the prefix off (M7R119). */
export function SkillChip({ skill, onRemove }: { readonly skill: string; onRemove(): void }) {
  const t = useT();
  return (
    <div
      data-skill-chip
      role="group"
      aria-label={t("sessionModels.commands.chip")}
      className="flex w-fit max-w-full items-center gap-s1 rounded-sm border border-control-border bg-surface-2 pl-s2"
    >
      <span className="truncate font-mono text-ui text-fg">{`$${skill}`}</span>
      <Button
        variant="ghost"
        aria-label={t("sessionModels.commands.removeSkill", { skill })}
        onClick={onRemove}
      >
        <span aria-hidden="true">×</span>
      </Button>
    </div>
  );
}
