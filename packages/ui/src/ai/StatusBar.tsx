import { Button } from "../primitives/Button.tsx";
import { AnsiText } from "./AnsiText.tsx";

export type StatusCell =
  | { readonly kind: "text"; readonly key: string; readonly text: string }
  | { readonly kind: "command"; readonly key: string; readonly command: string; readonly label: string };

export interface StatusBarProps {
  readonly cells: readonly StatusCell[];
  /** The session is working or changing state: a command would only queue behind it. */
  readonly busy: boolean;
  /** The group's accessible name. */
  readonly label: string;
  /** Says whose text the bar shows ("from an extension"): pap's own texts never use this word. */
  readonly sourceLabel: string;
  onCommand(command: string): void;
}

/**
 * What extensions put in the status bar. A `command` cell is a button: the label is the extension's, the command is
 * shown beside it, so a label cannot hide what the button runs.
 */
export function StatusBar(props: StatusBarProps) {
  if (props.cells.length === 0) return null;
  return (
    <div
      role="group"
      data-slot="status-bar"
      aria-label={props.label}
      className="flex flex-wrap items-center gap-s2"
    >
      <span className="label-hud text-muted">{props.sourceLabel}</span>
      {props.cells.map((cell) =>
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
