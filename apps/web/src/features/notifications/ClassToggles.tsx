import type { NotificationsSettings } from "@pap/contracts";
import { Switch } from "@pap/ui";
import { useT } from "../../i18n/index.ts";

type ClassName = keyof NotificationsSettings["classes"];
const KINDS: readonly ClassName[] = ["approval", "failed", "budget", "notify", "done", "reply", "review"];

/** One switch per class (M12R2) and the names option (M12R7). Each change writes the whole document. */
export function ClassToggles({
  doc,
  disabled,
  onChange,
}: {
  readonly doc: NotificationsSettings;
  readonly disabled: boolean;
  onChange(change: (current: NotificationsSettings) => NotificationsSettings): void;
}) {
  const t = useT();
  return (
    <div className="flex max-w-xl flex-col gap-s3">
      {KINDS.map((name) => (
        <Switch
          key={name}
          label={t(`notifications.class.${name}`)}
          hint={t(`notifications.class.${name}.hint`)}
          checked={doc.classes[name]}
          disabled={disabled}
          onChange={(checked) =>
            onChange((current) => ({ ...current, classes: { ...current.classes, [name]: checked } }))
          }
        />
      ))}
      <Switch
        label={t("notifications.names.label")}
        hint={t("notifications.names.hint")}
        checked={doc.titles === "names"}
        disabled={disabled}
        onChange={(checked) => onChange((current) => ({ ...current, titles: checked ? "names" : "generic" }))}
      />
    </div>
  );
}
