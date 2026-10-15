import "../../i18n/register-home.ts";
import type { HomeLayout, ProjectSummary } from "@pap/contracts";
import { Badge, Button, Icon, IconSettings, Kbd } from "@pap/ui";
import { type ReactNode, useId, useRef, useState } from "react";
import { errorKey, type MessageKey, useLazyFailureText, useT } from "../../i18n/index.ts";
import { LazyMenu } from "../../lib/LazyMenu.tsx";
import { getRuntime, RpcError } from "../../runtime/index.ts";
import { randomId } from "../../runtime/random-id.ts";
import { useInboxStore } from "../../stores/inbox-store.ts";
import { useLaneStore } from "../../stores/lane-store.ts";
import type { HomeActions, HomeChord, HomeSettingsSection, HomeShortcuts } from "./home-actions.ts";
import { useRootAccess } from "./use-root-access.ts";

function Group({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-s1">
      <h2 id={id} className="label-hud text-muted">
        {title}
      </h2>
      <div className="flex flex-wrap items-start gap-s2">{children}</div>
    </section>
  );
}

/** A visible action; one that cannot run stays, disabled, its reason visible and named by `aria-describedby` (§3.2, §7). */
function Action(props: {
  readonly label: string;
  /** The accessible name when it says more than the label (the unread count). */
  readonly name?: string;
  readonly reason: string | null;
  /** A failure of the last attempt: shown, never disabling. */
  readonly notice?: string | null;
  readonly chord?: HomeChord;
  readonly children?: ReactNode;
  onClick(): void;
}) {
  const id = useId();
  return (
    <span className="flex flex-col gap-s1">
      <Button
        size="sm"
        aria-label={props.name ?? props.label}
        disabled={props.reason !== null}
        aria-describedby={props.reason === null ? undefined : id}
        onClick={props.onClick}
      >
        {props.label}
        {props.children}
        {props.chord !== undefined && props.chord.keys.length > 0 ? (
          <Kbd keys={props.chord.keys} joiner={props.chord.joiner} />
        ) : null}
      </Button>
      {props.reason === null ? null : (
        <span id={id} className="text-ui text-muted">
          {props.reason}
        </span>
      )}
      {props.notice === undefined || props.notice === null ? null : (
        <span role="status" className="text-ui text-attn">
          {props.notice}
        </span>
      )}
    </span>
  );
}

interface Props {
  readonly project: ProjectSummary | null;
  readonly layout: HomeLayout;
  readonly actions: HomeActions;
  readonly shortcuts: HomeShortcuts;
}

/** §3.2: Explore · Automate · Project · Help, each group hidden from Settings › Appearance › Home. */
export function ActionRow({ project, layout, actions, shortcuts }: Props) {
  const t = useT();
  const lazyText = useLazyFailureText();
  const unread = useInboxStore((state) => state.view.unread);
  const archived = useLaneStore((state) => state.view.archived);
  const root = project?.root ?? null;
  const access = useRootAccess(layout.explore ? root : null);
  const starting = useRef(false);
  const [terminal, setTerminal] = useState<{ readonly root: string; readonly key: MessageKey } | null>(null);
  if (!layout.explore && !layout.automate && !layout.project && !layout.help) return null;

  const rootReason: MessageKey | null = root === null ? "home.reason.noProject" : access;
  const terminalNotice = terminal !== null && terminal.root === root ? terminal.key : null;
  const openTerminal = () => {
    if (root === null || starting.current) return;
    starting.current = true;
    setTerminal(null);
    getRuntime()
      .rpc.call("terminal.create", { requestId: randomId(16), cwd: root, cols: 80, rows: 24 })
      .then(
        (created) => {
          starting.current = false;
          actions.open({ kind: "terminal", id: created.terminalId });
        },
        (failure: unknown) => {
          starting.current = false;
          setTerminal({ root, key: errorKey(failure instanceof RpcError ? failure.code : "internal") });
        },
      );
  };
  const settings = (section: HomeSettingsSection, label: MessageKey) => ({
    id: section,
    label: t(label),
    onSelect: () => actions.open({ kind: "settings", section }),
  });

  return (
    <div data-home-actions="" className="flex flex-wrap gap-s4">
      {layout.explore ? (
        <Group title={t("home.group.explore")}>
          <Action
            label={t("home.action.files")}
            reason={rootReason === null ? null : t(rootReason)}
            onClick={() => {
              if (root !== null) actions.open({ kind: "files", root });
            }}
          />
          <Action
            label={t("home.action.terminal")}
            reason={rootReason === null ? null : t(rootReason)}
            notice={terminalNotice === null ? null : t(terminalNotice)}
            onClick={openTerminal}
          />
          <Action
            label={t("home.action.search")}
            reason={null}
            chord={shortcuts.search}
            onClick={() => actions.openSearch(project?.id ?? null)}
          />
        </Group>
      ) : null}
      {layout.automate ? (
        <Group title={t("home.group.automate")}>
          <Action
            label={t("home.action.tasks")}
            reason={null}
            onClick={() => actions.open({ kind: "tasks" })}
          />
          <Action
            label={t("home.action.inbox")}
            name={
              unread > 0
                ? `${t("home.action.inbox")}, ${t("home.action.inboxCount", { count: unread })}`
                : undefined
            }
            reason={null}
            onClick={() => actions.openInbox()}
          >
            {unread > 0 ? (
              <Badge count={unread} label={t("home.action.inboxCount", { count: unread })} />
            ) : null}
          </Action>
        </Group>
      ) : null}
      {layout.project ? (
        <Group title={t("home.group.project")}>
          <Action
            label={t("home.action.archived", { count: archived })}
            reason={null}
            onClick={() => actions.openTree()}
          />
          <LazyMenu
            label={t("home.action.project")}
            closeLabel={t("ui.close")}
            text={lazyText}
            items={[
              settings("skills", "home.action.skills"),
              settings("mcp", "home.action.mcp"),
              settings("approvals", "home.action.approvals"),
            ]}
            trigger={(ask) => (
              <Button size="sm" onClick={ask}>
                <Icon icon={IconSettings} size={14} />
                {t("home.action.project")}
              </Button>
            )}
          />
        </Group>
      ) : null}
      {layout.help ? (
        <Group title={t("home.group.help")}>
          <Action
            label={t("home.action.shortcuts")}
            reason={null}
            chord={shortcuts.help}
            onClick={() => actions.openShortcuts()}
          />
        </Group>
      ) : null}
    </div>
  );
}
