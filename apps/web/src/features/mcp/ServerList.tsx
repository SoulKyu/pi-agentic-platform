import type { McpFileView, McpServerView } from "@pap/contracts";
import { Button, Chip, Switch, Heading, InlineError } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import { escapeHidden, groupSwitch, rowChip, serverKey, type RowChip } from "./mcp.vm.ts";

function StateChip({ chip }: { readonly chip: RowChip }) {
  const t = useT();
  const label = t(`settingsMcp.chip.${chip}` as const);
  switch (chip) {
    case "on":
    case "connected":
      return <Chip tone="ok" label={label} />;
    case "invalid":
    case "failed":
      return <Chip tone="err" label={label} />;
    case "not-trusted":
    case "needs-sign-in":
    case "timeout":
      return <Chip tone="att" label={label} />;
    default:
      return <Chip tone="mut" label={label} />;
  }
}

export interface ListHandlers {
  onSelect(key: string): void;
  onGroup(scope: "global" | "project", servers: readonly McpServerView[], enabled: boolean): void;
  onRow(server: McpServerView, enabled: boolean): void;
  /** Opens the trust dialog; absent when no folder is chosen. */
  onReviewTrust?(): void;
}

function Group({
  scope,
  file,
  selected,
  busy,
  handlers,
}: {
  readonly scope: "global" | "project";
  readonly file: McpFileView;
  readonly selected: string | null;
  readonly busy: boolean;
  readonly handlers: ListHandlers;
}) {
  const t = useT();
  const group = groupSwitch(file.servers);
  const untrusted = file.trusted === false;
  const title = t(scope === "global" ? "settingsMcp.group.global" : "settingsMcp.group.project");
  const frozen = busy || untrusted || file.problem !== null;
  return (
    <section className="flex flex-col gap-s2">
      <Heading level={2} variant="section">
        {title}
      </Heading>
      <p className="break-all text-ui text-muted">{escapeHidden(file.path)}</p>
      {file.problem !== null ? (
        <InlineError announce="background">{t(`settingsMcp.file.${file.problem}` as const)}</InlineError>
      ) : null}
      {untrusted ? <p className="text-ui text-attn">{t("settingsMcp.project.untrusted")}</p> : null}
      {untrusted && handlers.onReviewTrust ? (
        <Button onClick={handlers.onReviewTrust}>{t("settingsMcp.project.review")}</Button>
      ) : null}
      {file.servers.length === 0 ? (
        file.problem === null ? (
          <p className="text-ui text-muted">{t("settingsMcp.group.empty")}</p>
        ) : null
      ) : (
        <>
          <Switch
            label={t(
              scope === "global" ? "settingsMcp.group.switchGlobal" : "settingsMcp.group.switchProject",
            )}
            checked={group.on}
            disabled={frozen || group.total === 0}
            onChange={(on) => handlers.onGroup(scope, group.rows, on)}
            {...(!group.on && group.enabled > 0
              ? { hint: t("settingsMcp.group.partial", { on: group.enabled, total: group.total }) }
              : {})}
          />
          <ul aria-label={t("settingsMcp.list.label", { group: title })} className="flex flex-col gap-s1">
            {file.servers.map((server) => {
              const key = serverKey(server);
              const chip = rowChip(server);
              const invalid = server.kind === "invalid";
              return (
                <li key={key} className="flex items-center gap-s2">
                  <div className="min-w-0 flex-1">
                    <Button
                      variant="ghost"
                      data-server={key}
                      aria-current={key === selected ? "true" : undefined}
                      onClick={() => handlers.onSelect(key)}
                    >
                      <span className="min-w-0 flex-1 break-all text-left">{escapeHidden(server.name)}</span>
                      <StateChip chip={chip} />
                    </Button>
                    {invalid ? <p className="text-ui text-muted">{t("settingsMcp.row.invalid")}</p> : null}
                  </div>
                  <Switch
                    label={t("settingsMcp.row.switch", { name: escapeHidden(server.name) })}
                    checked={server.enabled}
                    disabled={frozen || invalid}
                    onChange={(on) => handlers.onRow(server, on)}
                  />
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

/** Rows grouped Global / Project, each with its state chip and switch, and a group switch above (M7R98). */
export function ServerList({
  global,
  project,
  selected,
  busy,
  handlers,
}: {
  readonly global: McpFileView;
  readonly project: McpFileView | null;
  readonly selected: string | null;
  readonly busy: boolean;
  readonly handlers: ListHandlers;
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-s4">
      <Group scope="global" file={global} selected={selected} busy={busy} handlers={handlers} />
      {project !== null ? (
        <Group scope="project" file={project} selected={selected} busy={busy} handlers={handlers} />
      ) : (
        <p className="text-ui text-muted">{t("settingsMcp.project.none")}</p>
      )}
    </div>
  );
}
