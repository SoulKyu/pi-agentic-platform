import { Button, Checkbox, cn, TextField } from "@pap/ui";
import { useState } from "react";
import { useT } from "../../i18n/index.ts";
import { shown } from "./board.vm.ts";
import { setTool, toolNotes, toolProblem, toolRows, type Mode } from "./editor.vm.ts";

interface ToolListProps {
  readonly tools: readonly string[];
  readonly mode: Mode;
  onChange(tools: string[]): void;
}

/**
 * The closed list of tools (owner m10a3): Pi's seven as checkboxes, unchecked ones struck through, and any name the
 * person adds (checked by `ToolName`). The notes say exactly what asks under the chosen mode (RT-13) and when the
 * read-only preset is off (RT-28).
 */
export function ToolList({ tools, mode, onChange }: ToolListProps) {
  const t = useT();
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const add = () => {
    const found = toolProblem(name, tools);
    if (found !== null) {
      setProblem(t(found === "bad" ? "automation.editor.tools.bad" : `automation.editor.tools.${found}`));
      return;
    }
    onChange(setTool(tools, name, true));
    setName("");
    setProblem(null);
  };

  return (
    <fieldset className="flex flex-col gap-s2">
      <legend className="label-hud mb-s1 text-muted">{t("automation.editor.tools")}</legend>
      <ul className="flex flex-wrap gap-s2">
        {toolRows(tools).map((tool) => {
          const on = tools.includes(tool);
          return (
            <li
              key={tool}
              data-tool-off={on ? undefined : "true"}
              className={cn(
                "rounded-sm border px-s2 font-mono text-code",
                on ? "border-border-strong text-fg" : "border-dashed border-border text-muted line-through",
              )}
            >
              <Checkbox
                label={shown(tool, "name")}
                checked={on}
                onChange={(next) => onChange(setTool(tools, tool, next))}
              />
            </li>
          );
        })}
      </ul>
      {toolNotes(mode, tools).map((key) => (
        <p key={key} className="text-ui text-muted">
          {t(key)}
        </p>
      ))}
      <div className="flex items-end gap-s2">
        <div className="min-w-0 flex-1">
          <TextField
            label={t("automation.editor.tools.add")}
            value={name}
            error={problem}
            onChange={(next) => {
              setName(next);
              setProblem(null);
            }}
          />
        </div>
        <Button onClick={add}>{t("automation.editor.tools.addButton")}</Button>
      </div>
    </fieldset>
  );
}
