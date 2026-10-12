import type { Widget } from "@pap/contracts";
import { AnsiText } from "./AnsiText.tsx";

/** The extension widgets of one placement, a line at a time: each line is parsed alone, so no style carries over. */
export function Widgets(props: {
  readonly widgets: readonly Widget[];
  readonly placement: Widget["placement"];
}) {
  const shown = props.widgets.filter(
    (widget) => widget.placement === props.placement && widget.lines.length > 0,
  );
  if (shown.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {shown.map((widget) => (
        <div key={widget.key} className="font-mono text-ui whitespace-pre text-fg overflow-x-auto">
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
