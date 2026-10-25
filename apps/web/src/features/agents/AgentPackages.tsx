import "./register-agent-catalog.ts";
import { AGENT_VM_LIMITS, SystemPackage } from "@pap/contracts";
import { Button, Checkbox, Chip, IconButton, IconClose, InlineError, TextField } from "@pap/ui";
import { useEffect, useState, type KeyboardEvent } from "react";
import { type MessageKey, useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import type { Draft } from "./agent-form.vm.ts";

interface Props {
  readonly systemPackages: Draft["systemPackages"];
  readonly packages: Draft["packages"];
  set(patch: Partial<Pick<Draft, "systemPackages" | "packages">>): void;
}

/** A package of the owner's Pi profile: its id (what the agent saves) and its masked source (only a label). */
interface PiPackage {
  readonly id: string;
  readonly source: string;
}
type PiSources =
  | { readonly state: "loading" | "failed"; retry(): void }
  | { readonly state: "ready"; readonly packages: readonly PiPackage[]; retry(): void };

/**
 * The owner's Pi packages (user scope) as `agents.packages` gives them (the member-safe list); loading and failed stay distinct from an empty profile.
 * The source is masked and is only shown: the agent saves the package's id, which the daemon resolves (AVM-E33).
 */
function usePiSources(): PiSources {
  const [result, setResult] = useState<
    { state: "loading" | "failed" } | { state: "ready"; packages: readonly PiPackage[] }
  >({
    state: "loading",
  });
  const [reads, setReads] = useState(0);
  useEffect(() => {
    let live = true;
    getRuntime()
      .rpc.call("agents.packages", {})
      .then(
        (answer) => {
          if (live)
            setResult({
              state: "ready",
              packages: [
                ...new Map(
                  answer.packages.map((one) => [one.id, { id: one.id, source: one.source }] as const),
                ).values(),
              ],
            });
        },
        () => {
          if (live) setResult({ state: "failed" });
        },
      );
    return () => {
      live = false;
    };
  }, [reads]);
  return {
    ...result,
    retry: () => {
      setResult({ state: "loading" });
      setReads((count) => count + 1);
    },
  };
}

/**
 * Debian packages for the agent's image (chips, each judged by `SystemPackage` before it is added) and which of the
 * owner's Pi packages go in: "All" (null) by default, or the ticked ones.
 */
export function AgentPackages({ systemPackages, packages, set }: Props) {
  const t = useT();
  const pi = usePiSources();
  const known = pi.state === "ready" ? pi.packages : [];
  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState<MessageKey | null>(null);

  const add = () => {
    const name = typed.trim();
    if (!SystemPackage.safeParse(name).success) return setProblem("agentVm.error.package");
    if (systemPackages.includes(name)) return setProblem("agentVm.error.packageTwice");
    if (systemPackages.length >= AGENT_VM_LIMITS.systemPackages)
      return setProblem("agentVm.error.packageLimit");
    set({ systemPackages: [...systemPackages, name] });
    setTyped("");
    setProblem(null);
  };
  // Enter adds the chip; it must not submit the agent form around the field.
  const onEnter = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    add();
  };

  // A saved pick the profile no longer lists stays on the list, ticked, so saving does not drop it silently.
  // A saved pick the profile no longer holds stays in the list (ticked, labelled gone), so the owner can drop it.
  const gone = (packages ?? []).filter((id) => !known.some((one) => one.id === id));
  const toggle = (id: string, on: boolean) =>
    set({ packages: on ? [...(packages ?? []), id] : (packages ?? []).filter((pick) => pick !== id) });

  return (
    <>
      <fieldset data-slot="agent-system-packages" className="flex min-w-0 flex-col gap-s2">
        <legend className="label-hud text-muted">{t("agentVm.system.title")}</legend>
        <div onKeyDown={onEnter} className="flex items-end gap-s1">
          <div className="min-w-0 flex-1">
            <TextField
              label={t("agentVm.system.field")}
              hint={t("agentVm.system.hint")}
              value={typed}
              error={problem === null ? null : t(problem, { max: AGENT_VM_LIMITS.systemPackages })}
              autoComplete="off"
              onChange={(value) => {
                setTyped(value);
                setProblem(null);
              }}
            />
          </div>
          <Button onClick={add}>{t("agentVm.system.add")}</Button>
        </div>
        {systemPackages.length === 0 ? (
          <p className="text-ui text-muted">{t("agentVm.system.none")}</p>
        ) : (
          <ul className="flex flex-wrap gap-s1">
            {systemPackages.map((name) => (
              <li key={name} className="flex items-center gap-s1">
                <Chip tone="mut" label={name} />
                <IconButton
                  size="sm"
                  icon={IconClose}
                  label={t("agentVm.system.remove", { name })}
                  onClick={() => set({ systemPackages: systemPackages.filter((one) => one !== name) })}
                />
              </li>
            ))}
          </ul>
        )}
      </fieldset>
      <fieldset data-slot="agent-pi-packages" className="flex min-w-0 flex-col gap-s2">
        <legend className="label-hud text-muted">{t("agentVm.pi.title")}</legend>
        <Checkbox
          label={t("agentVm.pi.all")}
          checked={packages === null}
          disabled={pi.state !== "ready"}
          onChange={(all) => set({ packages: all ? null : known.map((one) => one.id) })}
        />
        {pi.state === "loading" ? <p className="text-ui text-muted">{t("agentVm.pi.loading")}</p> : null}
        {pi.state === "failed" ? (
          <div className="flex items-center gap-s2">
            <InlineError announce="background">{t("agentVm.pi.failed")}</InlineError>
            <Button onClick={pi.retry}>{t("agentVm.pi.retry")}</Button>
          </div>
        ) : null}
        {packages === null ? (
          <p className="text-ui text-muted">{t("agentVm.pi.hint")}</p>
        ) : pi.state !== "ready" ? null : known.length + gone.length === 0 ? (
          <p className="text-ui text-muted">{t("agentVm.pi.none")}</p>
        ) : (
          <>
            {known.map((one) => (
              <Checkbox
                key={one.id}
                label={one.source}
                checked={packages.includes(one.id)}
                onChange={(on) => toggle(one.id, on)}
              />
            ))}
            {gone.map((id) => (
              <Checkbox key={id} label={t("agentVm.pi.gone")} checked onChange={(on) => toggle(id, on)} />
            ))}
          </>
        )}
      </fieldset>
    </>
  );
}
