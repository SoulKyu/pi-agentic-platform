import { Switch } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import { BUILTIN_IDS, BUILTIN_RESIDUALS } from "./policy-settings.vm.ts";

/** The preset switch and, in a disclosure, what it blocks and what it never caught (M5R92). */
export function BuiltinPreset({ on, onChange }: { on: boolean; onChange(on: boolean): void }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-s2">
      <Switch
        label={t("approvals.builtin.label")}
        hint={t("approvals.builtin.hint")}
        checked={on}
        onChange={onChange}
      />
      <details className="text-ui">
        <summary className="cursor-pointer rounded-sm py-s1 text-fg focus-ring pointer-coarse:min-h-11">
          {t("approvals.builtin.title")}
        </summary>
        <ul className="mt-s2 flex list-disc flex-col gap-s1 pl-s4 text-muted">
          {BUILTIN_IDS.map((id) => (
            <li key={id} data-builtin={id}>
              {t(`approvals.builtin.${id}`)}
            </li>
          ))}
        </ul>
        <p className="mt-s3 font-semibold text-fg">{t("approvals.cannot.title")}</p>
        <ul className="mt-s2 flex list-disc flex-col gap-s1 pl-s4 text-muted">
          {BUILTIN_RESIDUALS.map((id) => (
            <li key={id} data-residual={id}>
              {t(`approvals.cannot.${id}`)}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
