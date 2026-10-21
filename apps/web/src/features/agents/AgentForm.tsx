import "./register-agent-catalog.ts";
import { AgentView, APPROVAL_MODES, type SandboxStatus, type ToolPreset } from "@pap/contracts";
import { Button, Collapsible, Segmented, Select, Switch, TextField, usePendingAction } from "@pap/ui";
import { type ReactNode, useState } from "react";
import { errorKey, type MessageKey, useT } from "../../i18n/index.ts";
import type { PickerModel } from "../models/picker/index.ts";
import { useStepUpRunner } from "../../lib/step-up-context.tsx";
import { useVmStatus } from "../../lib/use-vm-status.ts";
import { getRuntime, RpcError } from "../../runtime/index.ts";
import { AgentPackages } from "./AgentPackages.tsx";
import { AgentResources } from "./AgentResources.tsx";
import { AutonomyFields } from "./AutonomyFields.tsx";
import { BudgetFields } from "./BudgetFields.tsx";
import { derivedInitials, draftFromInput, type Draft, needsStepUp, toInput } from "./agent-form.vm.ts";
import { MemoryFields } from "./MemoryFields.tsx";
import { levelsFor } from "./model-fields.vm.ts";
import { ModelFields } from "./ModelFields.tsx";
import { EgressLine, SandboxLine } from "./SandboxLine.tsx";
import type { NewAgentStart } from "./use-new-agent-defaults.ts";
import { useOwnerHosts } from "./use-owner-hosts.ts";

interface Props {
  /** The agent being edited (the Settings tab), or null for a new one. */
  readonly agent: AgentView | null;
  /** The sandbox probe, a prop until Task 16 wires `agents.sandboxStatus` (W5-R21). */
  readonly probe: SandboxStatus;
  /** M7's tool preset picker, given by the host so this feature imports no other feature. */
  presetField(value: ToolPreset, onChange: (preset: ToolPreset) => void): ReactNode;
  /** A new agent's starting sandbox, from the owner's agents settings (M11R99); an edited agent keeps its own. */
  readonly start?: NewAgentStart;
  onSaved(agent: AgentView): void;
  onCancel?(): void;
  /**
   * Reads the agent again (the Settings tab). The host replaces the agent it gave this form, and a new revision
   * re-keys the form; the same revision comes back to tell a taken name from a changed agent.
   */
  onReload?(): Promise<AgentView | null>;
}

const SAVE_ERRORS: Readonly<Record<string, MessageKey>> = {
  conflict: "agentForm.error.conflict",
  limit_reached: "agentForm.error.limit_reached",
  bad_request: "agentForm.error.bad_request",
  read_only: "agentForm.error.read_only",
  not_found: "agentForm.error.not_found",
};
const saveFailure = (failure: unknown): MessageKey => {
  const code = failure instanceof RpcError ? failure.code : "internal";
  return SAVE_ERRORS[code] ?? errorKey(code);
};

/**
 * The agent profile, shared by the new-agent dialog and the agent's Settings tab (M11R93). Every value is judged by
 * `AgentInput` through the view-model. A save that widens what the agent can do says so first and goes through the
 * shell's password step-up (M11R94); any other save is sent as it is.
 */
export function AgentForm({ agent, probe, presetField, start, onSaved, onCancel, onReload }: Props) {
  const t = useT();
  const stepUp = useStepUpRunner();
  const pending = usePendingAction();
  const runtime = useVmStatus().status?.runtime;
  const vm = runtime === "vm";
  // Known to be host mode: an unreadable status leaves the daemon to judge the list.
  const hostMode = runtime === "host";
  const reloading = usePendingAction();
  const before = agent?.input ?? null;
  const [draft, setDraft] = useState(() => ({
    ...draftFromInput(before),
    ...(agent === null && start ? { sandboxRequired: start.required, network: start.network } : {}),
  }));
  // What the picker said about the model picked in this form; a saved model that was not picked has none (all levels).
  const [picked, setPicked] = useState<PickerModel | undefined>(undefined);
  const [attempted, setAttempted] = useState(false);
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const [roleHelp, setRoleHelp] = useState(false);

  const built = toInput(draft, hostMode);
  const errors = attempted && !built.ok ? built.errors : {};
  const fail = (key: string) => {
    const error = errors[key];
    return error === undefined ? null : t(error);
  };
  const ownerHosts = useOwnerHosts();
  const widens = needsStepUp(before, draft, ownerHosts);
  const typedName = draft.name.trim().replace(/^@/, "");
  const set = (patch: Partial<Draft>) => {
    setDraft((previous) => ({ ...previous, ...patch }));
    setProblem(null);
  };

  const reload = () =>
    void reloading.run(async () => {
      const fresh = await onReload?.().catch(() => null);
      if (fresh === null || fresh === undefined) setProblem("agentForm.error.reloadFailed");
      else if (fresh.revision === agent?.revision) setProblem("agentForm.error.conflict.name");
    });

  const save = () =>
    void pending.run(async () => {
      setAttempted(true);
      if (!built.ok) {
        setProblem("agentForm.fix");
        return;
      }
      const { input } = built;
      const { rpc } = getRuntime();
      const run = (commandId: string) =>
        agent === null
          ? rpc.call("agents.create", { input }, { commandId })
          : rpc.call(
              "agents.update",
              { agentId: agent.id, baseRevision: agent.revision, input },
              { commandId },
            );
      // The choice is made before the try: the React Compiler bails out on a conditional inside one.
      const send = widens ? () => stepUp(run) : () => run(rpc.newCommandId());
      try {
        const saved = await send();
        if (saved !== null) onSaved(AgentView.parse(saved));
      } catch (failure) {
        setProblem(saveFailure(failure));
      }
    });

  return (
    <form
      data-agent-form=""
      className="flex flex-col gap-s3 p-s3"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <TextField
        label={t("agentForm.name")}
        hint={t("agentForm.name.hint")}
        value={draft.name}
        error={fail("name")}
        autoComplete="off"
        onChange={(name) => set({ name })}
      />
      <TextField
        label={t("agentForm.initials")}
        hint={t("agentForm.initials.hint")}
        value={draft.initials}
        placeholder={derivedInitials(draft.name)}
        error={fail("initials")}
        autoComplete="off"
        onChange={(initials) => set({ initials })}
      />
      <TextField
        label={t("agentForm.role")}
        multiline
        rows={4}
        value={draft.role}
        error={fail("role")}
        onChange={(role) => set({ role })}
      />
      <Collapsible
        open={roleHelp}
        onOpenChange={setRoleHelp}
        trigger={<span className="text-ui text-muted">{t("agentForm.role.about")}</span>}
      >
        <p className="text-ui text-muted">{t("agentForm.role.help")}</p>
      </Collapsible>
      <ModelFields
        model={draft.model}
        preset={draft.preset}
        thinking={draft.thinking}
        levels={levelsFor(picked)}
        onModel={(model, summary) => {
          setPicked(summary);
          set({ model });
        }}
        onThinking={(thinking) => set({ thinking })}
      />
      <Select
        label={t("agentForm.mode")}
        value={draft.mode}
        options={APPROVAL_MODES.map((mode) => ({ value: mode, label: t(`agentForm.mode.${mode}`) }))}
        onChange={(mode) => set({ mode })}
      />
      {presetField(draft.preset, (preset) => set({ preset }))}
      <fieldset data-slot="agent-sandbox" className="flex min-w-0 flex-col gap-s2">
        <legend className="label-hud text-muted">{t("agentForm.sandbox")}</legend>
        {vm ? (
          <>
            <p className="text-ui text-muted">{t("agentVm.sandboxNote")}</p>
            <Switch
              label={t("agentForm.network")}
              hint={t("agentVm.network.hint")}
              checked={draft.network}
              onChange={(network) => set({ network })}
            />
          </>
        ) : (
          <>
            <SandboxLine probe={probe} />
            <Segmented
              label={t("agentForm.sandbox")}
              value={draft.sandboxRequired ? "required" : "off"}
              options={[
                { value: "required", label: t("agentForm.sandbox.required") },
                { value: "off", label: t("agentForm.sandbox.off") },
              ]}
              onChange={(value) => set({ sandboxRequired: value === "required" })}
            />
            {draft.sandboxRequired && probe.checkedAt !== 0 && !probe.usable ? (
              <p className="text-ui text-attn">{t("agentForm.sandbox.unusableHint")}</p>
            ) : null}
            {draft.sandboxRequired ? (
              <Switch
                label={t("agentForm.network")}
                hint={t("agentForm.network.hint")}
                checked={draft.network}
                onChange={(network) => set({ network })}
              />
            ) : (
              <p role="status" className="text-ui text-attn">
                {typedName === ""
                  ? t("agentForm.sandbox.offWarning.unnamed")
                  : t("agentForm.sandbox.offWarning", { name: typedName })}
              </p>
            )}
            {draft.sandboxRequired && draft.network ? <EgressLine probe={probe} /> : null}
            <p className="text-ui text-muted">{t("agentForm.sandbox.folders")}</p>
          </>
        )}
      </fieldset>
      <fieldset data-slot="agent-hosts" className="flex min-w-0 flex-col gap-s2">
        <legend className="label-hud text-muted">{t("agentForm.hosts")}</legend>
        <Segmented
          label={t("agentForm.hosts")}
          value={draft.ownHosts ? "own" : "only"}
          options={[
            { value: "own", label: t("agentForm.hosts.own") },
            { value: "only", label: t("agentForm.hosts.only") },
          ]}
          onChange={(value) => set({ ownHosts: value === "own" })}
        />
        {draft.ownHosts ? null : (
          <TextField
            label={t("agentForm.hosts.field")}
            hint={t("agentForm.hosts.hint")}
            multiline
            mono
            rows={3}
            value={draft.hosts}
            error={fail("allowHosts")}
            onChange={(hosts) => set({ hosts })}
          />
        )}
        {draft.ownHosts ? null : <p className="text-ui text-attn">{t("agentForm.hosts.risk")}</p>}
      </fieldset>
      <AutonomyFields draft={draft} errors={errors} name={typedName} set={set} />
      <TextField
        label={t("agentForm.deny")}
        hint={t("agentForm.deny.hint")}
        multiline
        mono
        rows={3}
        value={draft.denylist}
        error={fail("denylist")}
        onChange={(denylist) => set({ denylist })}
      />
      <BudgetFields draft={draft} errors={errors} set={set} />
      <Switch
        label={t("agentForm.delegation")}
        hint={t("agentForm.delegation.hint")}
        checked={draft.acceptsDelegation}
        onChange={(acceptsDelegation) => set({ acceptsDelegation })}
      />
      <MemoryFields draft={draft} errors={errors} set={set} />
      {vm ? <AgentResources draft={draft} errors={errors} set={set} /> : null}
      {vm ? (
        <AgentPackages systemPackages={draft.systemPackages} packages={draft.packages} set={set} />
      ) : null}
      {widens ? (
        <p role="status" className="text-ui text-attn">
          {t("agentForm.stepUp", { name: typedName })}
        </p>
      ) : null}
      {problem !== null ? (
        <p role="alert" className="text-ui text-attn">
          {t(problem)}
        </p>
      ) : null}
      {problem === "agentForm.error.conflict" && agent !== null && onReload !== undefined ? (
        <div>
          <Button pendingSince={reloading.since} onClick={reload}>
            {t("agentForm.reload")}
          </Button>
        </div>
      ) : null}
      <div className="flex justify-end gap-s2">
        {onCancel ? <Button onClick={onCancel}>{t("agentForm.cancel")}</Button> : null}
        <Button
          variant="primary"
          type="submit"
          pendingSince={pending.since}
          stageLabel={t(agent === null ? "agentForm.creating" : "agentForm.saving")}
        >
          {t(agent === null ? "agentForm.create" : "agentForm.save")}
        </Button>
      </div>
    </form>
  );
}
