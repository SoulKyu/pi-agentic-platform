import { Heading } from "@pap/ui";
import type { McpServerView, TrustStatus } from "@pap/contracts";
import { useT } from "../../i18n/index.ts";
import { escapeHidden } from "../../lib/escape-hidden.ts";
import { hasResources, names } from "./trust.vm.ts";

function Server({ server }: { readonly server: McpServerView }) {
  const t = useT();
  // An address sends the variables its entry refers to (pi-web's dialog, M7R107): names only, never a value.
  const sends = server.kind === "http" ? [...server.variables, ...server.headerNames] : [];
  return (
    <li className="flex min-w-0 flex-col">
      <span className="break-all font-mono text-ui text-fg">{escapeHidden(server.name)}</span>
      <span className="break-all text-ui text-muted">{escapeHidden(server.target)}</span>
      {sends.length > 0 ? (
        <span className="break-all text-ui text-attn">{t("trust.mcp.sends", { names: names(sends) })}</span>
      ) : null}
      {server.commandFields.length > 0 ? (
        <span className="break-all text-ui text-attn">
          {t("trust.mcp.command", { fields: names(server.commandFields) })}
        </span>
      ) : null}
    </li>
  );
}

function NameList({
  title,
  note,
  list,
}: {
  readonly title: string;
  readonly note?: string;
  readonly list: readonly string[];
}) {
  return (
    <section className="flex flex-col gap-s1">
      <Heading level={4} variant="card">
        {title}
      </Heading>
      {note ? <p className="text-ui text-muted">{note}</p> : null}
      <ul className="flex flex-col">
        {list.map((name, index) => (
          <li key={`${index}:${name}`} className="break-all font-mono text-ui text-fg">
            {escapeHidden(name)}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** What trusting turns on, in the dashed attention frame of external content (DESIGN §2): every name is project text, shown escaped. */
export function TrustResources({ status }: { readonly status: TrustStatus }) {
  const t = useT();
  const { resources } = status;
  return (
    <div
      data-trust-resources
      className="flex flex-col gap-s2 rounded-md border border-dashed border-attn p-s2"
    >
      <Heading level={3} variant="group" tone="attn">
        {t("trust.resources.title")}
      </Heading>
      <p className="text-ui text-muted">{t("trust.resources.external")}</p>
      {hasResources(status) ? null : <p className="text-ui text-muted">{t("trust.nothing")}</p>}
      {resources.mcpServers.length > 0 ? (
        <section className="flex flex-col gap-s1">
          <Heading level={4} variant="card">
            {t("trust.mcp", { count: resources.mcpServers.length })}
          </Heading>
          <ul className="flex flex-col gap-s1">
            {resources.mcpServers.map((server, index) => (
              <Server key={`${index}:${server.name}`} server={server} />
            ))}
          </ul>
        </section>
      ) : null}
      {resources.extensions.length > 0 ? (
        <NameList
          title={t("trust.extensions", { count: resources.extensions.length })}
          note={t("trust.extensions.note")}
          list={resources.extensions}
        />
      ) : null}
      {resources.skills.length > 0 ? (
        <NameList title={t("trust.skills", { count: resources.skills.length })} list={resources.skills} />
      ) : null}
      {resources.promptTemplates > 0 ? (
        <p className="text-ui text-fg">{t("trust.templates", { count: resources.promptTemplates })}</p>
      ) : null}
      {resources.settingsKeys.length > 0 ? (
        <p className="break-all text-ui text-fg">
          {t("trust.settings", { keys: names(resources.settingsKeys) })}
        </p>
      ) : null}
      {resources.systemPrompt ? <p className="text-ui text-fg">{t("trust.systemPrompt")}</p> : null}
    </div>
  );
}
