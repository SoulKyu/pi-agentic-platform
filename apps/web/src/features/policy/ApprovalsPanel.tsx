import { MAX_ALLOW_HOSTS, MAX_DENY_PATTERNS } from "@pap/contracts";
import { Button, InlineError, Switch } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import { BuiltinPreset } from "./BuiltinPreset.tsx";
import { LocalToolsField } from "./LocalToolsField.tsx";
import { ModeField } from "./ModeField.tsx";
import { PatternField } from "./PatternField.tsx";
import { ReadOnlyCommands } from "./ReadOnlyCommands.tsx";
import { RulesByProject } from "./RulesByProject.tsx";
import { useSettingsForm } from "./use-settings-form.ts";

const HEADING = "text-ui font-semibold text-fg";
const NOTE = "text-ui text-muted";

/** Settings › Approvals: the owner's defaults (one form, one Save) and the always rules (their own list). */
export function ApprovalsPanel() {
  const t = useT();
  const state = useSettingsForm();
  const { form, check } = state;
  if (!state.ready) {
    return state.error ? (
      <div className="flex flex-col items-start gap-s2">
        <InlineError announce="background">{state.error}</InlineError>
        <Button variant="secondary" onClick={state.reload}>
          {t("approvals.retry")}
        </Button>
      </div>
    ) : (
      <p className={NOTE}>{t("approvals.loading")}</p>
    );
  }
  return (
    <div className="flex flex-col gap-s6">
      <div className="flex flex-col gap-s5">
        <section className="flex flex-col gap-s2">
          <h2 className={HEADING}>{t("approvals.mode.title")}</h2>
          <ModeField mode={form.defaultMode} onChange={(defaultMode) => state.edit({ defaultMode })} />
        </section>
        <section className="flex flex-col gap-s3">
          <h2 className={HEADING}>{t("approvals.readOnly.title")}</h2>
          <ReadOnlyCommands
            on={form.readOnlyCommands}
            onChange={(readOnlyCommands) => state.edit({ readOnlyCommands })}
          />
        </section>
        <section className="flex flex-col gap-s3">
          <h2 className={HEADING}>{t("approvals.blocked.title")}</h2>
          <PatternField
            kind="pattern"
            label={t("approvals.blocked.label")}
            hint={t("approvals.blocked.hint")}
            text={form.denylistText}
            parsed={check.deny}
            max={MAX_DENY_PATTERNS}
            onChange={(denylistText) => state.edit({ denylistText })}
          >
            <p className={NOTE}>{t("approvals.blocked.fullAccess")}</p>
            <p className={NOTE}>{t("approvals.blocked.complex")}</p>
          </PatternField>
          <BuiltinPreset
            on={form.builtinDenylist}
            onChange={(builtinDenylist) => state.edit({ builtinDenylist })}
          />
        </section>
        <section className="flex flex-col gap-s3">
          <h2 className={HEADING}>{t("approvals.hosts.title")}</h2>
          <Switch
            label={t("approvals.hosts.switch")}
            hint={t("approvals.hosts.switchHint")}
            checked={form.hostsOn}
            onChange={(hostsOn) => state.edit({ hostsOn })}
          />
          <p className={NOTE}>{t("approvals.hosts.limits")}</p>
          {form.hostsOn ? (
            <PatternField
              kind="host"
              label={t("approvals.hosts.label")}
              hint={t("approvals.hosts.hint")}
              text={form.hostsText}
              parsed={check.hosts}
              max={MAX_ALLOW_HOSTS}
              onChange={(hostsText) => state.edit({ hostsText })}
            >
              {check.hosts.values.length === 0 ? <p className={NOTE}>{t("approvals.hosts.empty")}</p> : null}
            </PatternField>
          ) : null}
        </section>
        <section className="flex flex-col gap-s3">
          <h2 className={HEADING}>{t("approvals.local.title")}</h2>
          <LocalToolsField
            rules={form.localTools}
            draft={form.localDraft}
            onRules={(localTools) => state.edit({ localTools })}
            onDraft={(localDraft) => state.edit({ localDraft })}
          />
        </section>
        <div className="flex flex-col items-start gap-s2">
          {check.tooLarge ? (
            <InlineError announce="action">{t("approvals.error.tooLarge")}</InlineError>
          ) : null}
          {check.draftPending ? <p className={NOTE}>{t("approvals.local.pending")}</p> : null}
          {check.deny.errors.length > 0 || check.hosts.errors.length > 0 ? (
            <p className={NOTE}>{t("approvals.invalid")}</p>
          ) : null}
          {state.notice === "conflict" ? (
            <InlineError announce="action">{t("approvals.conflict")}</InlineError>
          ) : null}
          {state.notice === "saved" ? (
            <p role="status" className={NOTE}>
              {t("approvals.saved")}
            </p>
          ) : null}
          {state.error ? <InlineError announce="action">{state.error}</InlineError> : null}
          <Button variant="primary" disabled={!check.valid || state.busy} onClick={state.save}>
            {t("approvals.save")}
          </Button>
        </div>
      </div>
      <RulesByProject />
    </div>
  );
}
