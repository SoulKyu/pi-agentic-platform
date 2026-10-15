import { Button, Chip, TextField } from "@pap/ui";
import { useState } from "react";
import { useT } from "../../i18n/index.ts";
import { shown } from "./board.vm.ts";
import { envProblem } from "./editor.vm.ts";

interface EnvListProps {
  readonly env: readonly string[];
  readonly error: string | null;
  onChange(env: string[]): void;
}

/** Names of daemon variables the precheck keeps (owner m10q7): never a value. A name that looks like a credential is refused here, as at save. */
export function EnvList({ env, error, onChange }: EnvListProps) {
  const t = useT();
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const add = () => {
    const found = envProblem(name, env);
    if (found !== null) {
      setProblem(
        found === "never"
          ? t("automation.editor.env.never", { name: shown(name, "name") })
          : t(`automation.editor.env.${found}`),
      );
      return;
    }
    onChange([...env, name]);
    setName("");
    setProblem(null);
  };

  return (
    <div className="flex flex-col gap-s2">
      <span className="label-hud text-muted">{t("automation.editor.env")}</span>
      <ul className="flex flex-wrap items-center gap-s2">
        {env.map((one) => (
          <li key={one} className="flex items-center gap-s1">
            <Chip tone="mut" label={one} />
            <Button
              size="sm"
              variant="ghost"
              aria-label={t("automation.editor.env.remove", { name: one })}
              onClick={() => onChange(env.filter((other) => other !== one))}
            >
              ×
            </Button>
          </li>
        ))}
      </ul>
      <div className="flex items-end gap-s2">
        <div className="min-w-0 flex-1">
          <TextField
            label={t("automation.editor.env.add")}
            value={name}
            error={problem ?? error}
            onChange={(next) => {
              setName(next);
              setProblem(null);
            }}
          />
        </div>
        <Button onClick={add}>{t("automation.editor.env.addButton")}</Button>
      </div>
      <p className="text-ui text-muted">{t("automation.editor.env.note")}</p>
    </div>
  );
}
