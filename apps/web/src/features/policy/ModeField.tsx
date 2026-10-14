import { APPROVAL_MODES, type ApprovalMode } from "@pap/contracts";
import { FOCUS_RING } from "@pap/ui";
import { useId } from "react";
import { useT } from "../../i18n/index.ts";

const NOTE = "text-ui text-muted";

/**
 * The four approval modes as one labelled radio group, each with its description always visible (M7R123). Native
 * radios of one name: one tab stop, the arrow keys move and select, as a screen reader announces them.
 */
export function ModeField({ mode, onChange }: { mode: ApprovalMode; onChange(mode: ApprovalMode): void }) {
  const t = useT();
  const id = useId();
  return (
    <div className="flex flex-col gap-s2">
      <div role="radiogroup" aria-label={t("approvals.mode.label")} className="flex flex-col gap-s2">
        {APPROVAL_MODES.map((value) => (
          <label key={value} className="flex items-start gap-s2 pointer-coarse:min-h-11">
            <input
              type="radio"
              name={`${id}-mode`}
              checked={mode === value}
              onChange={() => onChange(value)}
              aria-labelledby={`${id}-${value}-name`}
              aria-describedby={`${id}-${value}-hint`}
              className={`mt-s1 accent-agent ${FOCUS_RING}`}
            />
            <span className="flex flex-col">
              <span id={`${id}-${value}-name`} className="text-ui text-fg">
                {t(`approvals.mode.${value}`)}
              </span>
              <span id={`${id}-${value}-hint`} className={NOTE}>
                {t(`approvals.mode.${value}.hint`)}
                {value === "full-access" && mode === value
                  ? ` ${t("approvals.mode.full-access.limits")}`
                  : ""}
              </span>
            </span>
          </label>
        ))}
      </div>
      <p className={NOTE}>{t("approvals.mode.hint")}</p>
    </div>
  );
}
