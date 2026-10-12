import { AnsiText } from "./AnsiText.tsx";

export interface WidgetsProps {
  readonly widgets: readonly {
    readonly key: string;
    readonly lines: readonly string[];
    readonly placement: string;
  }[];
  readonly placement: string;
}

/** The extension widgets of one placement, a line at a time: each line is parsed alone, so no style carries over. */
export function Widgets(props: WidgetsProps) {
  const shown = props.widgets.filter(
    (widget) => widget.placement === props.placement && widget.lines.length > 0,
  );
  if (shown.length === 0) return null;
  return (
    <div className="flex flex-col gap-s2">
      {shown.map((widget) => (
        <div key={widget.key} className="overflow-x-auto whitespace-pre font-mono text-ui text-fg">
          {widget.lines.map((line, index) => (
            // Lines are replaced whole on each update: the index is their identity.
            <div key={index} data-widget-line>
              <AnsiText text={line} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
