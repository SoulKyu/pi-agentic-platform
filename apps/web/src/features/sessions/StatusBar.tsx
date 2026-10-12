import type { StatusEntry } from "@pap/contracts";
import { Button } from "@pap/ui";
import { useMemo } from "react";
import { useT } from "../../i18n/index.ts";
import { AnsiText } from "./AnsiText.tsx";
import { statusCells } from "./status-cells.ts";

/**
 * What extensions put in the status bar. `command:` cells are buttons: the label is the extension's, the command comes
 * from the key and is shown beside it, so a label cannot hide what the button runs (M2R135). The bar says whose text it
 * is (M2R138).
 */
export function StatusBar(props: {
  readonly statuses: readonly StatusEntry[];
  /** The session is working or changing state: a command would only queue behind it. */
  readonly busy: boolean;
  readonly onCommand: (command: string) => void;
}) {
  const t = useT();
  const cells = useMemo(() => statusCells(props.statuses), [props.statuses]);
  if (cells.length === 0) return null;
  return (
    <div role="group" aria-label={t("status.label")} className="flex flex-wrap items-center gap-2">
      <span className="font-mono text-label uppercase tracking-label text-muted">
        {t("source.extension")}
      </span>
      {cells.map((cell) =>
        cell.kind === "command" ? (
          <Button key={cell.key} disabled={props.busy} onClick={() => props.onCommand(cell.command)}>
            <span>{cell.label}</span> <span className="font-mono text-muted">{cell.command}</span>
          </Button>
        ) : (
          <span key={cell.key} className="text-ui text-fg">
            <AnsiText text={cell.text} />
          </span>
        ),
      )}
    </div>
  );
}
