import { Button, Checkbox, Segmented, TextField } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import { EditorSection, type SectionProps } from "./EditorSection.tsx";
import { effectiveMode, effectiveUsd } from "./editor.vm.ts";
import { EnvList } from "./EnvList.tsx";
import { ToolList } from "./ToolList.tsx";

/** Execution (board 11 §1, "isolated-task"): the target, the folder, the tool list and mode, the precheck and the run's bounds. */
export function ExecutionSection({ draft, set, errors }: SectionProps) {
  const t = useT();
  const mode = effectiveMode(draft);
  const usd = effectiveUsd(draft);
  return (
    <EditorSection title={t("automation.editor.execution")}>
      <div className="flex flex-wrap items-end gap-s3">
        <Segmented
          label={t("automation.editor.target")}
          value="isolated"
          options={[{ value: "isolated", label: t("automation.editor.target.isolated") }]}
          onChange={() => {}}
        />
        <Button disabled>{t("automation.editor.target.thread")}</Button>
      </div>
      <TextField
        label={t("automation.editor.cwd")}
        value={draft.cwd}
        error={errors["execution.cwd"] ?? null}
        onChange={(cwd) => set({ cwd })}
      />
      <ToolList tools={draft.tools} mode={mode} onChange={(tools) => set({ tools })} />
      <Segmented
        label={t("automation.editor.mode")}
        value={mode}
        options={[
          { value: "read-only", label: t("automation.editor.mode.read-only") },
          { value: "supervised", label: t("automation.editor.mode.supervised") },
          { value: "auto-accept-edits", label: t("automation.editor.mode.auto-accept-edits") },
        ]}
        onChange={(next) => set({ mode: next })}
      />
      <EnvList env={draft.env} error={errors["execution.env"] ?? null} onChange={(env) => set({ env })} />
      <TextField
        multiline
        mono
        rows={2}
        label={t("automation.editor.precheck")}
        hint={t("automation.editor.precheck.hint")}
        error={errors["execution.precheck"] ?? null}
        value={draft.precheck}
        onChange={(precheck) => set({ precheck })}
      />
      <Segmented
        label={t("automation.editor.interrupted")}
        value={draft.retryOnInterrupt ? "retry" : "no"}
        options={[
          { value: "no", label: t("automation.editor.interrupted.no") },
          { value: "retry", label: t("automation.editor.interrupted.retry") },
        ]}
        onChange={(next) => set({ retryOnInterrupt: next === "retry" })}
      />
      <TextField
        label={t("automation.editor.runMinutes")}
        value={draft.maxRunMinutes}
        error={errors["execution.maxRunMinutes"] ?? null}
        onChange={(maxRunMinutes) => set({ maxRunMinutes })}
      />
      <TextField
        label={t("automation.editor.runUsd")}
        value={usd}
        error={errors["execution.maxRunUsd"] ?? null}
        onChange={(maxRunUsd) => set({ maxRunUsd })}
      />
      <Checkbox
        label={t("automation.editor.noCap")}
        checked={usd === ""}
        onChange={(on) => set({ maxRunUsd: on ? "" : "1" })}
      />
      <TextField
        label={t("automation.editor.dailyBudget")}
        value={draft.dailyBudgetUsd}
        error={errors["execution.dailyBudgetUsd"] ?? null}
        onChange={(dailyBudgetUsd) => set({ dailyBudgetUsd })}
      />
    </EditorSection>
  );
}
