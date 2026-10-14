import type { McpServerView, McpTestResult } from "@pap/contracts";
import { Button, Select, Switch } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import { escapeHidden } from "./mcp.vm.ts";

type Exposure = McpServerView["exposure"];
const EXPOSURES: readonly Exposure[] = ["codemode", "deferred", "direct", "hidden"];

export interface DetailHandlers {
  onExposure(exposure: Exposure): void;
  onRemove(): void;
  onTest(): void;
  onInProject(enabled: boolean): void;
}

function Names({ label, names }: { readonly label: string; readonly names: readonly string[] }) {
  if (names.length === 0) return null;
  return (
    <p className="break-all text-ui text-fg">
      <span className="text-muted">{label}: </span>
      {names.map(escapeHidden).join(", ")}
    </p>
  );
}

function TestOutcome({
  server,
  result,
}: {
  readonly server: McpServerView;
  readonly result: McpTestResult | null;
}) {
  const t = useT();
  const state = result?.state ?? server.lastTest?.state ?? null;
  if (state === null) return null;
  const stateText = t(`settingsMcp.test.state.${state}` as const);
  return (
    <div className="flex flex-col gap-s1">
      {result === null ? (
        <p className="text-ui text-muted">
          {typeof server.lastTest?.tools === "number"
            ? t("settingsMcp.test.lastTools", { state: stateText, count: server.lastTest.tools })
            : t("settingsMcp.test.last", { state: stateText })}
        </p>
      ) : (
        <>
          <p className="text-ui text-fg">{stateText}</p>
          {result.message !== null ? (
            <p className="break-all text-ui text-muted">{escapeHidden(result.message)}</p>
          ) : null}
          {result.state === "connected" ? (
            result.tools.length === 0 ? (
              <p className="text-ui text-muted">{t("settingsMcp.test.noTools")}</p>
            ) : (
              <>
                <p className="label-hud text-muted">
                  {t("settingsMcp.test.tools", { count: result.tools.length })}
                </p>
                <ul className="flex flex-col gap-s1">
                  {result.tools.map((tool, index) => (
                    <li key={`${tool}-${index}`} className="break-all text-ui text-fg">
                      {escapeHidden(tool)}
                    </li>
                  ))}
                </ul>
                {result.toolsTruncated ? (
                  <p className="text-ui text-muted">{t("settingsMcp.test.moreTools")}</p>
                ) : null}
              </>
            )
          ) : null}
        </>
      )}
      {state === "needs-sign-in" ? <p className="text-ui text-attn">{t("settingsMcp.test.signIn")}</p> : null}
    </div>
  );
}

/**
 * What the overview sends about one server and nothing more (M7R98): the masked target, folder, the names of its
 * variables and headers, the `!command` fields (reported, never run), the exposure, Remove and Test. Why a control
 * is unavailable is written beside it.
 */
export function ServerDetail({
  server,
  busy,
  untrusted,
  testing,
  result,
  inProject,
  handlers,
}: {
  readonly server: McpServerView;
  readonly busy: boolean;
  readonly untrusted: boolean;
  readonly testing: boolean;
  readonly result: McpTestResult | null;
  /** For a global server while a project is open: whether the project switches it on (null: no project). */
  readonly inProject: boolean | null;
  readonly handlers: DetailHandlers;
}) {
  const t = useT();
  const invalid = server.kind === "invalid";
  const blocked = untrusted || invalid;
  return (
    <div data-mcp-detail className="flex min-w-0 flex-1 flex-col gap-s2">
      <h3 className="break-all text-ui font-semibold text-fg">{escapeHidden(server.name)}</h3>
      <p className="text-ui text-muted">{t(`settingsMcp.detail.kind.${server.kind}` as const)}</p>
      {server.problem !== null ? (
        <p className="text-ui text-attn">
          {t("settingsMcp.detail.problem", { problem: escapeHidden(server.problem) })}
        </p>
      ) : null}
      <p className="label-hud text-muted">{t("settingsMcp.detail.target")}</p>
      <p className="break-all font-mono text-ui text-fg">{escapeHidden(server.target)}</p>
      {server.cwd !== undefined ? (
        <p className="break-all text-ui text-fg">
          <span className="text-muted">{t("settingsMcp.detail.cwd")}: </span>
          {escapeHidden(server.cwd)}
        </p>
      ) : null}
      <Names label={t("settingsMcp.detail.env")} names={server.envNames} />
      <Names label={t("settingsMcp.detail.headers")} names={server.headerNames} />
      {server.commandFields.length > 0 ? (
        <p className="break-all text-ui text-attn">
          {t("settingsMcp.detail.commandFields", {
            fields: server.commandFields.map(escapeHidden).join(", "),
          })}
        </p>
      ) : null}
      {server.variables.length > 0 ? (
        <p className="break-all text-ui text-fg">
          {t(server.kind === "http" ? "settingsMcp.detail.variables" : "settingsMcp.detail.variablesStdio", {
            names: server.variables.map(escapeHidden).join(", "),
          })}
        </p>
      ) : null}
      {server.oauth ? <p className="text-ui text-muted">{t("settingsMcp.detail.oauth")}</p> : null}
      <p className="text-ui text-muted">
        {t("settingsMcp.detail.tools", { count: server.toolExposureCount })}
      </p>
      {inProject !== null ? (
        <Switch
          label={t("settingsMcp.detail.inProject")}
          checked={inProject}
          disabled={busy || blocked}
          onChange={handlers.onInProject}
        />
      ) : null}
      <Select<Exposure>
        label={t("settingsMcp.exposure.label")}
        value={server.exposure}
        options={EXPOSURES.map((value) => ({ value, label: t(`settingsMcp.exposure.${value}` as const) }))}
        disabled={busy || blocked}
        onChange={handlers.onExposure}
      />
      {untrusted ? <p className="text-ui text-attn">{t("settingsMcp.reason.untrusted")}</p> : null}
      {invalid ? <p className="text-ui text-attn">{t("settingsMcp.reason.invalid")}</p> : null}
      {busy && !testing ? <p className="text-ui text-muted">{t("settingsMcp.reason.busy")}</p> : null}
      <div className="flex gap-s2">
        <Button disabled={busy || blocked} onClick={handlers.onTest}>
          {testing ? t("settingsMcp.test.running") : t("settingsMcp.test")}
        </Button>
        <Button disabled={busy || untrusted} onClick={handlers.onRemove}>
          {t("settingsMcp.remove")}
        </Button>
      </div>
      <p className="text-ui text-muted">{t("settingsMcp.test.note")}</p>
      <TestOutcome server={server} result={result} />
    </div>
  );
}
