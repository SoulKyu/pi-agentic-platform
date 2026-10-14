import { useEffect } from "react";
import { useT } from "../../i18n/index.ts";
import "./register-models-catalog.ts";
import type { CommandRow } from "./composer-commands.vm.ts";

export interface CommandMenuProps {
  readonly id: string;
  /** `$` lists skills only. */
  readonly skillsOnly: boolean;
  readonly rows: readonly CommandRow[];
  /** The worker cut the list. */
  readonly truncated: boolean;
  /** Tells the field whether the rows are on the page. */
  onRendered(rendered: boolean): void;
  readonly active: number;
  pick(index: number): void;
}

/**
 * The `/` and `$` listbox under the field (M7R121). The field keeps the focus: rows are chosen by the keys or by a press.
 * Names and descriptions are untrusted: they are rendered as text, the descriptions already clipped.
 */
export default function CommandMenu({
  id,
  skillsOnly,
  rows,
  truncated,
  onRendered,
  active,
  pick,
}: CommandMenuProps) {
  const t = useT();
  useEffect(() => {
    onRendered(true);
    return () => onRendered(false);
  }, [onRendered]);
  return (
    <>
      <ul
        id={id}
        role="listbox"
        aria-label={t(skillsOnly ? "sessionModels.commands.skills" : "sessionModels.commands.list")}
        className="max-h-48 overflow-y-auto rounded-sm border border-control-border bg-bg py-s1"
      >
        {rows.map((row, index) => (
          <li
            key={row.key}
            id={`${id}-${index}`}
            role="option"
            aria-selected={index === active}
            // A press must not take the focus from the field.
            onMouseDown={(event) => {
              event.preventDefault();
              pick(index);
            }}
            className="flex cursor-pointer flex-col justify-center pointer-coarse:min-h-11 gap-s1 px-s2 py-s1 text-ui text-fg aria-selected:bg-surface-2"
          >
            <span className="truncate font-mono">{row.label}</span>
            {row.description ? <span className="truncate text-muted">{row.description}</span> : null}
          </li>
        ))}
      </ul>
      {truncated ? <p className="px-s2 text-ui text-muted">{t("sessionModels.commands.truncated")}</p> : null}
    </>
  );
}
