import type { VcsFile } from "@pap/contracts";
import { Chip, cn, FOCUS_RING } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import { countsOf, groupFiles, groupKey, KIND_KEYS, kindTone, rowPath } from "./changes.vm.ts";

interface ChangeListProps {
  readonly files: readonly VcsFile[];
  readonly selected: string | null;
  onSelect(path: string): void;
}

/** The changed files in groups. A row says its kind in a word, shows the path as text, and marks the selected one. */
export function ChangeList({ files, selected, onSelect }: ChangeListProps) {
  const t = useT();
  return (
    <nav aria-label={t("changes.list.label")} className="flex flex-col gap-s2 py-s1">
      {groupFiles(files).map((group) => (
        <section key={group.id} aria-labelledby={`changes-group-${group.id}`}>
          <h3
            id={`changes-group-${group.id}`}
            className="flex items-center gap-s1 px-s3 py-s1 label-hud text-muted"
          >
            {t(groupKey(group.id))}
            <span className="tabular-nums">{group.files.length}</span>
          </h3>
          <ul className="flex flex-col">
            {group.files.map((file) => {
              const on = file.path === selected;
              const counts = countsOf(file);
              return (
                <li key={file.path}>
                  <button
                    type="button"
                    data-path={file.path}
                    aria-current={on ? "true" : undefined}
                    onClick={() => onSelect(file.path)}
                    className={cn(
                      "flex min-h-control w-full cursor-pointer items-center gap-s2 border-l-2 px-s3 text-start text-ui pointer-coarse:min-h-11",
                      FOCUS_RING,
                      on
                        ? "border-agent bg-surface-2 text-fg"
                        : "border-transparent text-fg can-hover:hover:bg-surface",
                    )}
                  >
                    <Chip tone={kindTone(file.kind)} label={t(KIND_KEYS[file.kind])} />
                    <span className="min-w-0 flex-1 truncate font-mono text-code">{rowPath(file)}</span>
                    {counts === null ? null : (
                      <span className="shrink-0 font-mono text-code tabular-nums text-muted">{counts}</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </nav>
  );
}
