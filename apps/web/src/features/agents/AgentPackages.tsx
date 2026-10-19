import "./register-agent-catalog.ts";
import { AGENT_VM_LIMITS, SystemPackage } from "@pap/contracts";
import { Button, Checkbox, Chip, TextField } from "@pap/ui";
import { useEffect, useState, type KeyboardEvent } from "react";
import { type MessageKey, useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import type { Draft } from "./agent-form.vm.ts";

interface Props {
  readonly systemPackages: Draft["systemPackages"];
  readonly packages: Draft["packages"];
  set(patch: Partial<Pick<Draft, "systemPackages" | "packages">>): void;
}

type PiSources =
  | { readonly state: "loading" | "failed"; retry(): void }
  | { readonly state: "ready"; readonly sources: readonly string[]; retry(): void };

/** The helper masks credentials in a source (`user:secret@` becomes `\u2022\u2022\u2022@`): such a spelling is not the one settings.json holds. */
const MASK = "\u2022\u2022\u2022";
const isMasked = (source: string): boolean => source.includes(MASK);

/** The sources of the owner's Pi packages (user scope), as `plugins.list` spells them; loading and failed stay distinct from an empty profile. */
function usePiSources(): PiSources {
  const [result, setResult] = useState<
    { state: "loading" | "failed" } | { state: "ready"; sources: readonly string[] }
  >({
    state: "loading",
  });
  const [reads, setReads] = useState(0);
  useEffect(() => {
    let live = true;
    getRuntime()
      .rpc.call("plugins.list", {})
      .then(
        (answer) => {
          if (live)
            setResult({
              state: "ready",
              sources: [
                ...new Set(
                  answer.plugins.filter((plugin) => plugin.scope === "user").map((plugin) => plugin.source),
                ),
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
  const sources = pi.state === "ready" ? pi.sources : [];
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
  const listed = [...new Set([...sources, ...(packages ?? [])])];
  const toggle = (source: string, on: boolean) =>
    set({
      packages: on ? [...(packages ?? []), source] : (packages ?? []).filter((pick) => pick !== source),
    });

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
                <Button
                  size="sm"
                  aria-label={t("agentVm.system.remove", { name })}
                  onClick={() => set({ systemPackages: systemPackages.filter((one) => one !== name) })}
                >
                  ×
                </Button>
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
          onChange={(all) => set({ packages: all ? null : sources.filter((source) => !isMasked(source)) })}
        />
        {pi.state === "loading" ? <p className="text-ui text-muted">{t("agentVm.pi.loading")}</p> : null}
        {pi.state === "failed" ? (
          <div className="flex items-center gap-s2">
            <p role="alert" className="text-ui text-attn">
              {t("agentVm.pi.failed")}
            </p>
            <Button onClick={pi.retry}>{t("agentVm.pi.retry")}</Button>
          </div>
        ) : null}
        {packages === null ? (
          <p className="text-ui text-muted">{t("agentVm.pi.hint")}</p>
        ) : pi.state !== "ready" ? null : listed.length === 0 ? (
          <p className="text-ui text-muted">{t("agentVm.pi.none")}</p>
        ) : (
          listed.map((source) => (
            <div key={source} className="flex flex-col gap-s1">
              <Checkbox
                label={source}
                checked={packages.includes(source)}
                disabled={isMasked(source)}
                onChange={(on) => toggle(source, on)}
              />
              {isMasked(source) ? <p className="text-ui text-muted">{t("agentVm.pi.masked")}</p> : null}
            </div>
          ))
        )}
      </fieldset>
    </>
  );
}
