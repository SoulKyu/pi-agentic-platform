import { Button, Checkbox, Segmented, TextField } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import { EditorSection, type SectionProps } from "./EditorSection.tsx";
import { effectiveMode, effectiveTarget, effectiveUsd } from "./editor.vm.ts";
import { RunsAsField } from "./RunsAsField.tsx";
import { ToolList } from "./ToolList.tsx";

/** Execution (board 11 §1, "isolated-task"): the target, the folder, the tool list and mode, a stored precheck to clear, and the run's bounds. */
export function ExecutionSection({ draft, set, errors }: SectionProps) {
  const t = useT();
  const mode = effectiveMode(draft);
  const usd = effectiveUsd(draft);
  const agent = draft.agentId !== "";
  const thread = agent && effectiveTarget(draft) === "thread";
  return (
    <EditorSection title={t("automation.editor.execution")}>
      <RunsAsField draft={draft} set={set} />
      {agent ? null : (
        <TextField
          label={t("automation.editor.cwd")}
          value={draft.cwd}
          error={errors["execution.cwd"] ?? null}
          onChange={(cwd) => set({ cwd })}
        />
      )}
      {thread ? null : <ToolList tools={draft.tools} mode={mode} onChange={(tools) => set({ tools })} />}
      {thread ? null : (
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
      )}
      {draft.precheck.trim() === "" ? null : (
        <div className="flex items-end gap-s2">
          <div className="min-w-0 flex-1">
            <TextField
              multiline
              mono
              rows={2}
              disabled
              label={t("automation.editor.precheck")}
              hint={t("automation.editor.precheck.removed")}
              value={draft.precheck}
              onChange={() => {}}
            />
          </div>
          <Button variant="secondary" onClick={() => set({ precheck: "", env: [] })}>
            {t("automation.editor.precheck.clear")}
          </Button>
        </div>
      )}
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
