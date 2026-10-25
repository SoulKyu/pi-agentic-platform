import { Button, InlineError } from "@pap/ui";
import { Dialog } from "@pap/ui/overlays";
import { errorKey, useT } from "../../i18n/index.ts";
import { StatusPanel } from "./StatusPanel.tsx";
import type { PanelLayout } from "./status.vm.ts";
import type { useOpenThread } from "./use-agent-space.ts";

interface PanelSlotProps {
  readonly agentId: string;
  readonly layout: PanelLayout;
  readonly open: boolean;
  onClose(): void;
  onOpenSettings(): void;
  onOpenSession(sessionId: string): void;
  onOpenTrigger(triggerId: string): void;
}

/** The status panel where its layout puts it; nothing is mounted (so nothing is read) while it is closed. */
export function PanelSlot({ agentId, layout, open, onClose, onOpenTrigger, ...rest }: PanelSlotProps) {
  const t = useT();
  if (!open) return null;
  const panel = (
    <StatusPanel
      {...rest}
      agentId={agentId}
      layout={layout}
      onOpenTrigger={onOpenTrigger}
      onNewTrigger={() => onOpenTrigger(`new:agent:${agentId}`)}
      {...(layout === "sheet"
        ? {}
        : {
            closeLabel: t(layout === "pane" ? "agentStatus.close.pane" : "agentStatus.close.side"),
            onClose,
          })}
    />
  );
  if (layout === "side")
    return <aside className="flex w-status-panel shrink-0 flex-col border-l border-border">{panel}</aside>;
  if (layout === "pane") return panel;
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t("agentStatus.title")}
      hideTitle
      variant="sheet"
      closeLabel={t("ui.close")}
    >
      {panel}
    </Dialog>
  );
}

export function OpenStatus({
  unusable,
  state,
  onRetry,
  onOpenSettings,
}: {
  readonly unusable: "quarantined" | "unreadable" | null;
  readonly state: ReturnType<typeof useOpenThread>["state"];
  onRetry(): void;
  onOpenSettings(): void;
}) {
  const t = useT();
  const settings = <Button onClick={onOpenSettings}>{t("agentSpace.openSettings")}</Button>;
  if (unusable !== null)
    return (
      <div className="flex flex-col items-start gap-s2">
        <p role="status" className="text-ui text-muted">
          {t(unusable === "quarantined" ? "agentSpace.quarantined" : "agentSpace.unreadable")}
        </p>
        {settings}
      </div>
    );
  if (state.kind === "failed")
    return (
      <div className="flex flex-col items-start gap-s2">
        <InlineError announce="background">{t(errorKey(state.code))}</InlineError>
        <div className="flex flex-wrap gap-s2">
          {state.code === "sandbox_unavailable" ? settings : null}
          <Button variant="primary" onClick={onRetry}>
            {t("agentSpace.retry")}
          </Button>
        </div>
      </div>
    );
  return (
    <p role="status" className="text-ui text-muted">
      {t("agentSpace.opening")}
    </p>
  );
}
