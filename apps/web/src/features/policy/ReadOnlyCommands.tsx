import { READ_ONLY_COMMAND_NAMES } from "@pap/contracts";
import { Switch } from "@pap/ui";
import { useT } from "../../i18n/index.ts";

/** The switch for read-only shell commands, the commands it covers by name, and when it cannot act (M7R125). */
export function ReadOnlyCommands({ on, onChange }: { on: boolean; onChange(on: boolean): void }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-s2">
      <Switch
        label={t("approvals.readOnly.label")}
        hint={t("approvals.readOnly.hint")}
        checked={on}
        onChange={onChange}
      />
      {on ? <p className="text-ui text-muted">{t("approvals.readOnly.limits")}</p> : null}
      <details className="text-ui">
        <summary className="cursor-pointer rounded-sm py-s1 text-fg focus-ring pointer-coarse:min-h-11">
          {t("approvals.readOnly.list")}
        </summary>
        <p className="mt-s2 text-muted">{t("approvals.readOnly.forms")}</p>
        <ul className="mt-s2 flex flex-wrap gap-s2 font-mono text-muted">
          {READ_ONLY_COMMAND_NAMES.map((name) => (
            <li key={name} data-read-only-command={name}>
              {name}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
