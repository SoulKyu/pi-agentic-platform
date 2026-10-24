import { TerminalSurface } from "@pap/ui/terminal";
import { Banner, Button } from "@pap/ui";
import { useCallback, useRef, useState, type ReactNode } from "react";
import "../../i18n/register-terminal.ts";
import { useT, type Translate } from "../../i18n/index.ts";
import { basename } from "../../lib/session-label.ts";
import { getRuntime } from "../../runtime/index.ts";
import { randomId } from "../../runtime/random-id.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { useTerminalStore } from "../../stores/terminal-store.ts";
import { useTerminal } from "./use-terminal.ts";
import type { TerminalPaneView } from "./terminal.vm.ts";

interface TerminalPaneProps {
  readonly id: string;
  /** Closes the tab that shows this terminal; the shell gives it (features never import each other). */
  onClose(): void;
  /** Shows another terminal, a new one in the same folder. */
  onOpen(id: string): void;
}

/** One terminal (M8R81): xterm in the middle, the connection state above it, Close in the header. */
export function TerminalPane({ id, onClose, onOpen }: TerminalPaneProps) {
  const t = useT();
  const headerRef = useRef<HTMLHeadingElement>(null);
  const known = useTerminalStore((state) => state.view.terminals.get(id) ?? null);
  const [newFailed, setNewFailed] = useState(false);
  const closeTerminal = useCallback(async () => {
    await getRuntime().rpc.call("terminal.close", { terminalId: id });
    onClose();
  }, [id, onClose]);
  const { view, surface, controller } = useTerminal(id, closeTerminal);

  const openHere = (): void => {
    if (!known) return;
    setNewFailed(false);
    getRuntime()
      .rpc.call("terminal.create", {
        requestId: randomId(16),
        cwd: known.cwd,
        cols: 80,
        rows: 24,
        ...(known.sessionId === null ? {} : { sessionId: known.sessionId }),
      })
      .then(
        (created) => onOpen(created.terminalId),
        () => setNewFailed(true),
      );
  };

  // A box terminal's cwd is a guest path: it names its project instead.
  const projectName = useShellStore((state) =>
    known?.projectId == null ? null : (state.view.projects.get(known.projectId)?.name ?? null),
  );
  const title = known
    ? t("terminal.pane.titleIn", { folder: projectName ?? basename(known.cwd) })
    : t("terminal.pane.title");
  return (
    <div data-terminal-pane={id} className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-s2 border-b border-border px-s3 py-s2">
        <h2 ref={headerRef} data-terminal-header tabIndex={-1} className="min-w-0 truncate text-ui text-fg">
          {title}
        </h2>
        <span className="ms-auto flex items-center gap-s2">
          {view.confirmingClose ? (
            <>
              <span role="alert" className="text-ui text-fg">
                {t("terminal.close.ask")}
              </span>
              <Button variant="danger" size="sm" onClick={() => controller()?.confirmClose()}>
                {t("terminal.action.closeConfirm")}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => controller()?.cancelClose()}>
                {t("terminal.action.cancel")}
              </Button>
            </>
          ) : (
            <Button variant="secondary" size="sm" onClick={() => controller()?.requestClose()}>
              {t("terminal.action.close")}
            </Button>
          )}
        </span>
      </div>
      <Notices
        view={view}
        t={t}
        newFailed={newFailed}
        onNew={known ? openHere : null}
        onRetry={() => controller()?.retry()}
      />
      <div className="min-h-0 flex-1">
        <TerminalSurface
          label={t("terminal.surface.label")}
          {...surface}
          onLeave={() => headerRef.current?.focus()}
        />
      </div>
    </div>
  );
}

function Notices({
  view,
  t,
  newFailed,
  onNew,
  onRetry,
}: {
  readonly view: TerminalPaneView;
  readonly t: Translate;
  readonly newFailed: boolean;
  readonly onNew: (() => void) | null;
  readonly onRetry: () => void;
}) {
  const newHere = onNew ? (
    <Button variant="secondary" size="sm" onClick={onNew}>
      {t("terminal.action.newHere")}
    </Button>
  ) : null;
  let banner: ReactNode = null;
  if (view.phase === "attaching" || view.phase === "offline") {
    banner = (
      <Banner tone="offline" title={t("terminal.state.reconnecting")}>
        {view.slow ? t("terminal.state.reconnectingSlow") : null}
      </Banner>
    );
  } else if (view.phase === "busy") {
    banner = (
      <Banner
        tone="capacity"
        title={t("terminal.state.busy")}
        actions={
          view.busyExhausted ? (
            <Button variant="secondary" size="sm" onClick={onRetry}>
              {t("terminal.action.retry")}
            </Button>
          ) : null
        }
      >
        {view.busyExhausted
          ? t("terminal.state.busyExhausted")
          : view.slow
            ? t("terminal.state.busySlow")
            : null}
      </Banner>
    );
  } else if (view.phase === "exited") {
    banner = <Banner tone="capacity" title={exitText(view, t)} actions={newHere} />;
  } else if (view.phase === "gone") {
    banner = <Banner tone="capacity" title={t("terminal.state.gone")} actions={newHere} />;
  }
  if (!banner && !view.closeFailed && !newFailed) return null;
  return (
    <div className="flex flex-col gap-s2 px-s3 pt-s2">
      {banner}
      {view.closeFailed ? <Banner tone="crash" title={t("terminal.close.failed")} /> : null}
      {newFailed ? <Banner tone="crash" title={t("terminal.new.failed")} /> : null}
    </div>
  );
}

function exitText(view: TerminalPaneView, t: Translate): string {
  if (view.exit?.code != null) return t("terminal.state.exited", { code: view.exit.code });
  if (view.exit?.signal) return t("terminal.state.exitedSignal", { signal: view.exit.signal });
  return t("terminal.state.exitedUnknown");
}
