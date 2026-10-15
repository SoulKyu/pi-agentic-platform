import "./register-lane-commit-catalog.ts";
import type { VcsFile } from "@pap/contracts";
import { Button, Checkbox } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import { pathText } from "./commit-bar.vm.ts";

interface Props {
  readonly files: readonly VcsFile[];
  readonly unticked: ReadonlySet<string>;
  readonly disabled: boolean;
  readonly truncated: boolean;
  onToggle(path: string): void;
  onTickAll(ticked: boolean): void;
}

/** The files the next commit takes: all ticked until the person unticks one. Names are raw bytes from git, shown as text. */
export function FileChecklist({ files, unticked, disabled, truncated, onToggle, onTickAll }: Props) {
  const t = useT();
  if (files.length === 0) return <p className="text-ui text-muted">{t("laneCommit.files.none")}</p>;
  const none = files.every((file) => unticked.has(file.path));
  return (
    <div className="flex flex-col gap-s1">
      <div className="flex items-center justify-between gap-s2">
        <span className="label-hud text-muted">{t("laneCommit.files.list")}</span>
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onTickAll(none)}>
          {none ? t("laneCommit.files.tickAll") : t("laneCommit.files.untickAll")}
        </Button>
      </div>
      <ul
        aria-label={t("laneCommit.files.list")}
        className="flex max-h-40 flex-col gap-s1 overflow-auto font-mono text-code"
      >
        {files.map((file) => (
          <li key={file.path} className="min-w-0 break-all">
            <Checkbox
              label={pathText(file)}
              checked={!unticked.has(file.path)}
              disabled={disabled}
              onChange={() => onToggle(file.path)}
            />
          </li>
        ))}
      </ul>
      {truncated ? (
        <p className="text-ui text-muted">{t("laneCommit.files.truncated", { count: files.length })}</p>
      ) : null}
    </div>
  );
}
