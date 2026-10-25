import type { SkillView } from "@pap/contracts";
import { Switch, Heading, InlineError } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import { escapeHidden, groupSwitch, skillGroups, type SkillGroupId } from "./skills.vm.ts";

export interface SkillHandlers {
  onGroup(id: SkillGroupId, rows: readonly SkillView[], on: boolean): void;
  onRow(row: SkillView, on: boolean): void;
}

/** Skills by where they live, each group with its switch and the rows a write refused under its heading (M7R118). */
export function SkillList({
  skills,
  busy,
  refused,
  handlers,
  hideProject,
}: {
  readonly skills: readonly SkillView[];
  readonly busy: boolean;
  /** Row refusals of the last write, by skill path. */
  readonly refused: ReadonlyMap<string, string>;
  readonly handlers: SkillHandlers;
  /** No project is chosen: its group would be empty and misleading. */
  readonly hideProject: boolean;
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-s4">
      {skillGroups(skills)
        .filter(
          (group) =>
            !(group.id === "project" && hideProject) && !(group.id === "other" && group.rows.length === 0),
        )
        .map((group) => {
          const title = t(`settingsSkills.group.${group.id}` as const);
          const summary = groupSwitch(group.rows.map((row) => ({ on: !row.disableModelInvocation })));
          const failures = group.rows.flatMap((row) => refused.get(row.path) ?? []);
          return (
            <section key={group.id} data-skill-group={group.id} className="flex flex-col gap-s2">
              <Heading level={4} variant="group">
                {title}
              </Heading>
              {failures.length > 0 ? (
                <ul className="flex flex-col gap-s1">
                  {failures.map((line) => (
                    <li key={line}>
                      <InlineError announce="action">{line}</InlineError>
                    </li>
                  ))}
                </ul>
              ) : null}
              {group.rows.length === 0 ? (
                <p className="text-ui text-muted">{t("settingsSkills.group.empty")}</p>
              ) : (
                <>
                  <Switch
                    label={t("settingsSkills.group.switch", { group: title })}
                    checked={summary.on}
                    disabled={busy}
                    onChange={(on) => handlers.onGroup(group.id, group.rows, on)}
                    {...(!summary.on && summary.enabled > 0
                      ? {
                          hint: t("settingsSkills.group.partial", {
                            on: summary.enabled,
                            total: summary.total,
                          }),
                        }
                      : {})}
                  />
                  <ul aria-label={title} className="flex flex-col gap-s1">
                    {group.rows.map((row) => (
                      <li key={row.path} className="flex items-center gap-s2">
                        <div className="min-w-0 flex-1">
                          <p className="break-all text-ui text-fg">{escapeHidden(row.name)}</p>
                          <p className="break-words text-ui text-muted">{escapeHidden(row.description)}</p>
                        </div>
                        <Switch
                          label={t("settingsSkills.row.switch", { name: escapeHidden(row.name) })}
                          checked={!row.disableModelInvocation}
                          disabled={busy}
                          onChange={(on) => handlers.onRow(row, on)}
                        />
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          );
        })}
    </div>
  );
}
