import { Heading } from "@pap/ui";
import "./register-space-catalog.ts";
import type { PermissionsView } from "@pap/contracts";
import { useId } from "react";
import { type MessageKey, useT } from "../../i18n/index.ts";

type Leg = "private" | "untrusted" | "exfil";
const LEGS: ReadonlyArray<readonly [Leg, keyof PermissionsView["trifecta"]]> = [
  ["private", "privateData"],
  ["untrusted", "untrustedContent"],
  ["exfil", "exfiltration"],
];

type Shell = "noshell." | "";
/** The leg's sentence; only the exfiltration leg has a variant per shell. */
const legKey = (leg: Leg, kind: "can" | "may" | "none", shell: Shell) =>
  (leg === "exfil" && kind !== "none"
    ? `agentSafety.tri.exfil.${shell}${kind}`
    : `agentSafety.tri.${leg}.${kind}`) as MessageKey;

const removeKey = (leg: Leg): MessageKey => `agentSafety.tri.remove.${leg}` as MessageKey;

/**
 * What the agent can do, in plain words (M11R126, M11R116): its tools, sandbox and egress, hosts, secrets' names, triggers,
 * and the lethal trifecta as advice. A leg that comes from assumptions, because no thread has listed its tools yet, reads
 * "may"; one seen in a live thread reads "can". Nothing here blocks anything.
 */
export function PermissionsSheet({ view }: { readonly view: PermissionsView }) {
  const t = useT();
  const titleId = useId();
  const { sandbox } = view;
  const assumed = view.tools.active === "unknown-until-start";
  const verb = assumed ? "may" : "can";
  // The shell always runs in the microVM: with no network, or behind the proxy.
  const exfil: Shell = view.egress === "off" ? "noshell." : "";
  const on = LEGS.filter(([, key]) => view.trifecta[key]);
  const all = on.length === LEGS.length;
  const hosts = Array.isArray(view.hosts)
    ? view.hosts.length === 0
      ? t("agentSafety.perm.hosts.none")
      : t("agentSafety.perm.hosts", { hosts: view.hosts.join(", ") })
    : view.hosts === "any"
      ? t("agentSafety.perm.hosts.any")
      : t("agentSafety.perm.hosts.owner");
  return (
    <section data-agent-permissions="" aria-labelledby={titleId} className="flex flex-col gap-s3">
      <h3 id={titleId} className="text-h2 text-fg">
        {t("agentSafety.perm.title")}
      </h3>
      <p className="text-ui text-muted">{t("agentSafety.perm.intro")}</p>
      <div className="flex flex-col gap-s2 rounded-md border border-border p-s3">
        <Heading level={4} variant="card">
          {t("agentSafety.tri.title", { n: on.length })}
        </Heading>
        <p className={all ? "text-ui text-attn" : "text-ui text-muted"}>
          {all ? t(`agentSafety.tri.all.${verb}`) : t("agentSafety.tri.none")}
        </p>
        <ul className="flex flex-col gap-s1">
          {LEGS.map(([leg, key]) => (
            <li key={leg} className={view.trifecta[key] ? "text-ui text-attn" : "text-ui text-muted"}>
              {t(legKey(leg, view.trifecta[key] ? verb : "none", exfil))}
            </li>
          ))}
        </ul>
        {all ? (
          <div className="flex flex-col gap-s1">
            <p className="label-hud text-muted">{t("agentSafety.tri.remove")}</p>
            <ul className="flex flex-col gap-s1 text-ui text-fg">
              {LEGS.map(([leg]) => (
                <li key={leg}>{t(removeKey(leg))}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      <ul className="flex flex-col gap-s1 text-ui text-fg">
        <li>{t("agentSafety.perm.tools", { preset: view.tools.preset })}</li>
        <li>
          {assumed
            ? t("agentSafety.perm.tools.unknown")
            : t("agentSafety.perm.tools.active", {
                tools: view.tools.active === "unknown-until-start" ? "" : view.tools.active.join(", "),
              })}
        </li>
        <li>{t("agentSafety.perm.sandbox.on")}</li>
        <li>{t(sandbox.network ? "agentSafety.perm.network.on" : "agentSafety.perm.network.off")}</li>
        <li>{t(`agentSafety.perm.egress.${view.egress}`)}</li>
        <li>{hosts}</li>
        <li>
          {view.trustedSources.length === 0
            ? t("agentSafety.perm.sources.none")
            : t("agentSafety.perm.sources", { hosts: view.trustedSources.join(", ") })}
        </li>
        <li>{t(view.trustedAutonomy ? "agentSafety.perm.autonomy.on" : "agentSafety.perm.autonomy.off")}</li>
        <li>{t("agentSafety.perm.blocked", { n: view.blocked })}</li>
        <li>
          {view.vaultNames.length === 0
            ? t("agentSafety.perm.vault.none")
            : t("agentSafety.perm.vault", { names: view.vaultNames.join(", ") })}
        </li>
        <li>{t("agentSafety.perm.mcp")}</li>
      </ul>
      <div className="flex flex-col gap-s1">
        <p className="label-hud text-muted">{t("agentSafety.perm.triggers")}</p>
        {view.triggers.length === 0 ? (
          <p className="text-ui text-muted">{t("agentSafety.perm.triggers.none")}</p>
        ) : (
          <ul className="flex flex-col gap-s1 text-ui text-fg">
            {view.triggers.map((trigger, index) => (
              <li key={`${index}:${trigger.name}`}>
                {t("agentSafety.perm.trigger", {
                  name: trigger.name,
                  source: t(`agentSafety.perm.source.${trigger.source}`),
                  target: t(`agentSafety.perm.target.${trigger.target}`),
                })}
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="text-ui text-muted">{t("agentSafety.perm.note")}</p>
    </section>
  );
}
