import type { PluginView } from "@pap/contracts";
import { Button, Chip, Switch } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import { escapeHidden, groupSwitch, pluginKey } from "./skills.vm.ts";

type PluginScope = PluginView["scope"];

export interface PluginHandlers {
  onGroup(scope: PluginScope, rows: readonly PluginView[], enabled: boolean): void;
  onRow(row: PluginView, enabled: boolean): void;
  onRemove(row: PluginView): void;
  onUpdate(scope: PluginScope): void;
}

function StateChip({ plugin }: { readonly plugin: PluginView }) {
  const t = useT();
  if (plugin.filtered) return <Chip tone="att" label={t("settingsSkills.plugin.chip.filtered")} />;
  if (plugin.installedPath === null)
    return <Chip tone="att" label={t("settingsSkills.plugin.chip.missing")} />;
  return plugin.enabled ? (
    <Chip tone="ok" label={t("settingsSkills.plugin.chip.on")} />
  ) : (
    <Chip tone="mut" label={t("settingsSkills.plugin.chip.off")} />
  );
}

/** Pi packages by scope, each group with its switch, Update, and the rows a write refused under its heading (M7R118). */
export function PluginList({
  plugins,
  busy,
  refused,
  handlers,
  hideProject,
}: {
  readonly plugins: readonly PluginView[];
  readonly busy: boolean;
  /** Row refusals of the last write, by `pluginKey`. */
  readonly refused: ReadonlyMap<string, string>;
  readonly handlers: PluginHandlers;
  readonly hideProject: boolean;
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-s4">
      {(["user", "project"] as const)
        .filter((scope) => !(scope === "project" && hideProject))
        .map((scope) => {
          const rows = plugins.filter((plugin) => plugin.scope === scope);
          const title = t(scope === "user" ? "settingsSkills.group.user" : "settingsSkills.group.project");
          const summary = groupSwitch(rows.map((row) => ({ on: row.enabled })));
          const failures = rows.flatMap((row) => refused.get(pluginKey(row)) ?? []);
          return (
            <section key={scope} data-plugin-group={scope} className="flex flex-col gap-s2">
              <h4 className="label-hud text-muted">{title}</h4>
              {failures.length > 0 ? (
                <ul role="alert" className="text-ui text-attn">
                  {failures.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              ) : null}
              {rows.length === 0 ? (
                <p className="text-ui text-muted">{t("settingsSkills.plugin.empty")}</p>
              ) : (
                <>
                  <Switch
                    label={t("settingsSkills.plugin.groupSwitch", { group: title })}
                    checked={summary.on}
                    disabled={busy}
                    onChange={(on) => handlers.onGroup(scope, rows, on)}
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
                    {rows.map((row) => (
                      <li key={pluginKey(row)} className="flex items-center gap-s2">
                        <span className="min-w-0 flex-1 break-all text-ui text-fg">
                          {escapeHidden(row.source)}
                        </span>
                        <StateChip plugin={row} />
                        <Switch
                          label={t("settingsSkills.plugin.switch", { name: escapeHidden(row.source) })}
                          checked={row.enabled}
                          disabled={busy || row.filtered}
                          onChange={(on) => handlers.onRow(row, on)}
                        />
                        <Button
                          disabled={busy}
                          aria-label={t("settingsSkills.plugin.removeLabel", {
                            name: escapeHidden(row.source),
                          })}
                          onClick={() => handlers.onRemove(row)}
                        >
                          {t("settingsSkills.plugin.remove")}
                        </Button>
                      </li>
                    ))}
                  </ul>
                  <div>
                    <Button disabled={busy} onClick={() => handlers.onUpdate(scope)}>
                      {t("settingsSkills.plugin.update")}
                    </Button>
                  </div>
                </>
              )}
            </section>
          );
        })}
    </div>
  );
}
