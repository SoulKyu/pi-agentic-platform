import { useT } from "../../../i18n/index.ts";
import "./register-files-catalog.ts";
import type { MentionMenuView } from "./use-mentions.ts";

/** The `@` listbox under the field. The field keeps the focus: rows are chosen by the keys or by a press. */
export function MentionMenu({ menu }: { readonly menu: MentionMenuView | null }) {
  const t = useT();
  if (menu === null) return null;
  return (
    <ul
      id={menu.id}
      role="listbox"
      aria-label={t("sessions.files.mentions")}
      className="max-h-48 overflow-y-auto rounded-sm border border-control-border bg-bg py-s1"
    >
      {menu.items.map((item, index) => (
        <li
          key={item.id}
          id={item.id}
          role="option"
          aria-selected={index === menu.active}
          // A press must not take the focus from the field.
          onMouseDown={(event) => {
            event.preventDefault();
            menu.pick(index);
          }}
          className="cursor-pointer truncate px-s2 py-s1 font-mono text-ui text-fg aria-selected:bg-surface-2"
        >
          {item.label}
        </li>
      ))}
    </ul>
  );
}
