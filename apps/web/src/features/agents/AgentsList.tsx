import "./register-agent-catalog.ts";
import { Avatar, type AvatarStyle, Button, Chip } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import type { AgentsView } from "../../stores/agents-reducer.ts";
import { STATE_CHIP } from "./agent-state.ts";

interface Props {
  /** The `agents` stream's view (Task 9's store): the list never opens a subscription of its own. */
  readonly view: AgentsView;
  readonly avatarStyle: AvatarStyle;
  onOpen(agentId: string): void;
  onNew(): void;
}

/** Settings › Agents › the list (M11R97): name, state, Open, and New agent (one of its four entry points, M11R96). */
export function AgentsList({ view, avatarStyle, onOpen, onNew }: Props) {
  const t = useT();
  return (
    <section aria-labelledby="agents-list-title" className="flex flex-col gap-s3">
      <header className="flex flex-wrap items-center justify-between gap-s2">
        <h3 id="agents-list-title" tabIndex={-1} className="label-hud text-fg focus:outline-none">
          {t("settings.agents.list")}
        </h3>
        <Button variant="primary" onClick={onNew}>
          {t("settings.agents.new")}
        </Button>
      </header>
      {view.failed !== null ? (
        <p role="alert" className="text-ui text-attn">
          {t("settings.agents.feedFailed")}
        </p>
      ) : !view.loaded ? (
        <p role="status" className="text-ui text-muted">
          {t("settings.agents.loading")}
        </p>
      ) : view.agents.length === 0 ? (
        <p className="text-ui text-muted">{t("settings.agents.empty")}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
          {view.agents.map((agent) => (
            <li key={agent.id} className="flex items-center gap-s3 p-s2">
              <Avatar initials={agent.initials} name={agent.name} avatarStyle={avatarStyle} />
              <span className="min-w-0 flex-1 truncate text-ui text-fg">{agent.name}</span>
              <Chip tone={STATE_CHIP[agent.state]} label={t(`settings.agents.state.${agent.state}`)} />
              <Button
                size="sm"
                aria-label={t("settings.agents.openNamed", { name: agent.name })}
                onClick={() => onOpen(agent.id)}
              >
                {t("settings.agents.open")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
