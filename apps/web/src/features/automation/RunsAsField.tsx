import { OUTSIDE_TEXT_SOURCES } from "@pap/contracts";
import { Segmented, Select, Switch } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import { useAgents } from "../../stores/agents-store.ts";
import { shown } from "./board.vm.ts";
import type { SectionProps } from "./EditorSection.tsx";
import { effectiveTarget } from "./editor.vm.ts";

/**
 * "Runs as" (M11R127): a project's folder or an agent; for an agent, which one and where it runs, with one line each.
 * A webhook or a feed offers the isolated task only (C §6.1). Nothing shows while the owner has no agent.
 */
export function RunsAsField({ draft, set }: Pick<SectionProps, "draft" | "set">) {
  const t = useT();
  const agents = useAgents((view) => view.agents);
  if (agents.length === 0 && draft.agentId === "") return null;
  const found = agents.find((agent) => agent.id === draft.agentId);
  const name = shown(found?.name ?? draft.agentId, "name");
  const target = effectiveTarget(draft);
  const outside = OUTSIDE_TEXT_SOURCES.has(draft.sourceType);
  const options = agents.map((agent) => ({ value: agent.id, label: shown(agent.name, "name") }));
  if (found === undefined && draft.agentId !== "") options.push({ value: draft.agentId, label: name });

  return (
    <div className="flex flex-col gap-s3">
      <Segmented
        label={t("automation.editor.runsAs")}
        value={draft.agentId === "" ? "project" : "agent"}
        options={[
          { value: "project", label: t("automation.editor.runsAs.project") },
          { value: "agent", label: t("automation.editor.runsAs.agent") },
        ]}
        onChange={(next) => set({ agentId: next === "project" ? "" : (agents[0]?.id ?? "") })}
      />
      {draft.agentId === "" ? null : (
        <>
          <Select
            label={t("automation.editor.agent")}
            value={draft.agentId}
            options={options}
            onChange={(agentId) => set({ agentId })}
          />
          <Segmented
            label={t("automation.editor.target")}
            value={target}
            options={[
              ...(outside ? [] : [{ value: "thread" as const, label: t("automation.editor.target.thread") }]),
              { value: "isolated" as const, label: t("automation.editor.target.isolated") },
            ]}
            onChange={(next) => set(next === "thread" ? { target: next, keep: false } : { target: next })}
          />
          <p className="text-ui text-muted">
            {t(`automation.editor.target.${target}.line`, { name })}
            {outside ? ` ${t("automation.editor.target.outside")}` : ""}
          </p>
          {target === "isolated" ? (
            <Switch
              label={t("automation.editor.keep")}
              hint={t("automation.editor.keep.hint")}
              checked={draft.keep}
              onChange={(keep) => set({ keep })}
            />
          ) : null}
        </>
      )}
    </div>
  );
}
