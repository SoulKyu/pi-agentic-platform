import "../../i18n/register-boxes.ts";
import "../../i18n/register-previews.ts";
import { boxKey, type BoxRef } from "@pap/contracts";
import { Button, InlineError, PREVIEW_SANDBOX, SandboxedFrame, usePendingAction } from "@pap/ui";
import { useState, type ReactNode } from "react";
import { errorKey, useT } from "../../i18n/index.ts";
import { getRuntime, RpcError } from "../../runtime/index.ts";
import { phaseOf } from "../../stores/box-phase.ts";
import { previewKey, usePreviewsStore } from "../../stores/previews-store.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { BoxStart } from "../boxes/BoxStart.tsx";
import { windowPath } from "./previews.vm.ts";
import { LogsButton } from "./LogsButton.tsx";
import { StartDeclared } from "./StartDeclared.tsx";
import { usePreviewLease } from "./use-preview-lease.ts";

interface Props {
  /** Stable across renders (the lease hook depends on it). */
  readonly box: BoxRef;
  readonly name: string;
  /** True only when the owner's own click mounted the pane (UX2-R77); a restored or rearranged pane loads nothing. */
  readonly armed: boolean;
  /** The shell opens the agent's tab (features never import the workspace). */
  onOpenAgent(agentId: string): void;
}

/**
 * A box service's page in the untrusted frame (UX2-R39). Never starts anything by itself: a stopped box shows START, a
 * service that is not running shows why, and a lease is minted only by the owner's own action (UX2-R77).
 */
export function PreviewPane({ box, name, armed, onOpenAgent }: Props) {
  const t = useT();
  const lease = usePreviewLease(box, name, armed);
  const service = usePreviewsStore((state) => state.services.get(previewKey(box, name)));
  const ready = usePreviewsStore((state) => state.ready);
  const project = useShellStore((state) =>
    box.kind === "project" ? state.view.projects.get(box.id) : undefined,
  );
  const phase = project === undefined ? "running" : phaseOf(project);
  const stop = usePendingAction();
  const running = service?.state === "running";
  // A project whose phase says running is no longer stopped, whatever an earlier refusal said.
  const startedSince = box.kind === "project" && project !== undefined && phase === "running";
  const boxStopped =
    (box.kind === "project" && phase !== "running") || (lease.error === "box_stopped" && !startedSince);
  const error = lease.error === "box_stopped" && startedSince ? null : lease.error;
  // A running service ends "gone": the pane offers OPEN PREVIEW again, and never mints by itself (UX2-R77).
  const gone = !running && (lease.state === "gone" || ready);
  const [stopProblem, setStopProblem] = useState<string | null>(null);
  const stopService = () =>
    void stop.run(async () => {
      setStopProblem(null);
      const { rpc } = getRuntime();
      try {
        await rpc.call("previews.stop", { box, name }, { commandId: rpc.newCommandId() });
      } catch (failure) {
        setStopProblem(t(errorKey(failure instanceof RpcError ? failure.code : "internal")));
      }
    });

  let body;
  if (boxStopped) {
    body =
      box.kind === "project" ? (
        <Notice text={t("previews.boxStopped")}>
          <BoxStart box={box} phase={phase === "running" ? "stopped" : phase} />
        </Notice>
      ) : (
        <Notice text={t("previews.agentStopped")}>
          <Button variant="secondary" onClick={() => onOpenAgent(box.id)}>
            {t("previews.openAgent")}
          </Button>
        </Notice>
      );
  } else if (gone) {
    body = (
      <Notice text={t("previews.gone")}>
        {service?.reason ? (
          <p className="text-ui text-muted">
            {t(`previews.reason.${service.reason}`, { port: service.port })}
          </p>
        ) : null}
        {box.kind === "project" ? <StartDeclared projectId={box.id} phase={phase} /> : null}
      </Notice>
    );
  } else if (lease.state === "open" && lease.url !== null) {
    body = (
      <SandboxedFrame
        key={lease.reloads}
        src={lease.url}
        sandbox={PREVIEW_SANDBOX}
        label={t("previews.frame", { name })}
        title={t("previews.frameTitle", { name })}
      />
    );
  } else {
    body = (
      <Notice text={t(lease.state === "restarted" ? "previews.restarted" : "previews.notOpen")}>
        {error === null ? null : <InlineError announce="action">{t(errorKey(error))}</InlineError>}
        <Button variant="secondary" onClick={lease.open}>
          {t("previews.open")}
        </Button>
      </Notice>
    );
  }
  return (
    <div data-preview-pane={boxKey(box)} className="flex min-h-0 flex-1 flex-col gap-s2 p-s2">
      <div className="flex flex-wrap items-center gap-s2">
        {lease.state === "open" ? (
          <Button variant="ghost" size="sm" onClick={lease.reload}>
            {t("previews.reload")}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          disabled={!running}
          onClick={() => window.open(windowPath(box, name), "_blank", "noopener")}
        >
          {t("previews.newTab")}
        </Button>
        <LogsButton box={box} name={name} />
        <Button variant="ghost" size="sm" disabled={!running} pendingSince={stop.since} onClick={stopService}>
          {t("previews.stop")}
        </Button>
      </div>
      {lease.lost === null ? null : (
        <InlineError announce="background">{t(errorKey(lease.lost))}</InlineError>
      )}
      {stopProblem === null ? null : <InlineError announce="action">{stopProblem}</InlineError>}
      {body}
      <p className="text-ui text-muted">{t("previews.cookies")}</p>
    </div>
  );
}

function Notice({ text, children }: { readonly text: string; readonly children?: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-start gap-s2 rounded-md border border-dashed border-border p-s3">
      <p className="text-ui text-fg">{text}</p>
      {children}
    </div>
  );
}
