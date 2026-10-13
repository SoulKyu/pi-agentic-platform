import { APPROVAL_MODES, MAX_ALLOW_HOSTS, MAX_DENY_PATTERNS, type ApprovalMode } from "@pap/contracts";
import { Button, Segmented, Switch } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import { BuiltinPreset } from "./BuiltinPreset.tsx";
import { PatternField } from "./PatternField.tsx";
import { RulesByProject } from "./RulesByProject.tsx";
import { useSettingsForm } from "./use-settings-form.ts";

const HEADING = "text-ui font-semibold text-fg";
const NOTE = "text-ui text-muted";

function ModeField({ mode, onChange }: { mode: ApprovalMode; onChange(mode: ApprovalMode): void }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-s2">
      <Segmented
        label={t("approvals.mode.label")}
        value={mode}
        options={APPROVAL_MODES.map((value) => ({ value, label: t(`approvals.mode.${value}`) }))}
        onChange={onChange}
      />
      <p className={NOTE}>{t(`approvals.mode.${mode}.hint`)}</p>
      {mode === "full-access" ? <p className={NOTE}>{t("approvals.mode.full-access.limits")}</p> : null}
      <p className={NOTE}>{t("approvals.mode.hint")}</p>
    </div>
  );
}

/** Settings › Approvals: the owner's defaults (one form, one Save) and the always rules (their own list). */
export function ApprovalsPanel() {
  const t = useT();
  const state = useSettingsForm();
  const { form, check } = state;
  if (!state.ready) {
    return state.error ? (
      <div className="flex flex-col items-start gap-s2">
        <p role="alert" className="text-ui text-attn">
          {state.error}
        </p>
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
          <h3 className={HEADING}>{t("approvals.mode.title")}</h3>
          <ModeField mode={form.defaultMode} onChange={(defaultMode) => state.edit({ defaultMode })} />
        </section>
        <section className="flex flex-col gap-s3">
          <h3 className={HEADING}>{t("approvals.blocked.title")}</h3>
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
          <h3 className={HEADING}>{t("approvals.hosts.title")}</h3>
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
        <div className="flex flex-col items-start gap-s2">
          {check.tooLarge ? (
            <p role="alert" className="text-ui text-attn">
              {t("approvals.error.tooLarge")}
            </p>
          ) : null}
          {!check.valid && !check.tooLarge ? <p className={NOTE}>{t("approvals.invalid")}</p> : null}
          {state.notice === "conflict" ? (
            <p role="status" className="text-ui text-attn">
              {t("approvals.conflict")}
            </p>
          ) : null}
          {state.notice === "saved" ? (
            <p role="status" className={NOTE}>
              {t("approvals.saved")}
            </p>
          ) : null}
          {state.error ? (
            <p role="alert" className="text-ui text-attn">
              {state.error}
            </p>
          ) : null}
          <Button variant="primary" disabled={!check.valid || state.busy} onClick={state.save}>
            {t("approvals.save")}
          </Button>
        </div>
      </div>
      <RulesByProject />
    </div>
  );
}
