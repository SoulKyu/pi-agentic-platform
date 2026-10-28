import "./register-models-catalog.ts";
import type { SessionLoadout, ThinkingLevel } from "@pap/contracts";
import { Button, InlineError } from "@pap/ui";
import type { MenuItem } from "@pap/ui/overlays";
import { type ReactNode, useState } from "react";
import { useLazyFailureText, useT } from "../../i18n/index.ts";
import { LazyMenu } from "../../lib/LazyMenu.tsx";
import { LazyPanel } from "../../lib/LazyPanel.tsx";
import { getRuntime } from "../../runtime/index.ts";
import { defaultFailureText } from "./model-menu.vm.ts";
import { SessionTools } from "./SessionTools.tsx";
import { useAction } from "./use-action.ts";

// The menu (a dialog, a search field, the model list) is a chunk of its own, fetched on the first press of the pill.
const loadModelMenu = () => import("./ModelMenu.tsx");

interface ModelBarProps {
  readonly sessionId: string;
  /** Null while the session is cold: the worker that knows its model is not running. */
  readonly loadout: SessionLoadout | null;
  readonly running: boolean;
  /** The last item of the pills' wrapping row: the usage line (UX-1). */
  readonly after?: ReactNode;
}

/** The model and reasoning pills of the composer (DESIGN §9.2). */
export function ModelBar({ sessionId, loadout, running, after }: ModelBarProps) {
  const t = useT();
  const lazyText = useLazyFailureText();
  const runtime = getRuntime();
  const [open, setOpen] = useState(false);
  const level = useAction(undefined, undefined, defaultFailureText);
  const levelName = (value: ThinkingLevel) => t(`sessionModels.level.${value}`);
  const model = loadout?.model ?? null;
  const modelLabel = model ? `${model.provider} · ${model.id}` : t("sessionModels.pill.none");

  const setLevel = (value: ThinkingLevel) =>
    void level.run(() =>
      runtime.rpc.call(
        "sessions.setThinking",
        { sessionId, level: value },
        { commandId: runtime.rpc.newCommandId() },
      ),
    );
  const items: MenuItem[] = loadout
    ? [
        ...loadout.levels.map((value) => ({
          id: value,
          label:
            value === loadout.thinkingLevel
              ? t("sessionModels.levelCurrent", { level: levelName(value) })
              : levelName(value),
          onSelect: () => setLevel(value),
        })),
        {
          id: "default",
          label: t("sessionModels.setDefaultLevel", { level: levelName(loadout.thinkingLevel) }),
          onSelect: () =>
            void level.run(() =>
              runtime.rpc.call(
                "models.setDefaultThinking",
                { level: loadout.thinkingLevel },
                { commandId: runtime.rpc.newCommandId() },
              ),
            ),
        },
      ]
    : [];

  return (
    <div data-model-bar className="flex flex-col gap-s1">
      <div className="flex flex-wrap items-center gap-s2">
        <Button variant="pill" size="sm" disabled={running} onClick={() => setOpen(true)}>
          {modelLabel}
        </Button>
        {loadout ? (
          <LazyMenu
            label={t("sessionModels.levelMenu")}
            closeLabel={t("sessionModels.menu.close")}
            text={lazyText}
            items={items}
            trigger={(ask) => (
              <Button variant="pill" size="sm" disabled={level.busy} onClick={ask}>
                {t("sessionModels.pill.thinking", { level: levelName(loadout.thinkingLevel) })}
              </Button>
            )}
          />
        ) : null}
        <SessionTools sessionId={sessionId} loadout={loadout} running={running} />
        {after}
      </div>
      {running ? <p className="text-ui text-muted">{t("sessionModels.idleOnly")}</p> : null}
      {level.error ? <InlineError announce="action">{level.error}</InlineError> : null}
      <LazyPanel
        load={loadModelMenu}
        open={open && !running}
        props={{
          sessionId,
          current: model ? { provider: model.provider, id: model.id } : null,
          onClose: () => setOpen(false),
        }}
        text={lazyText}
        onFailed={() => setOpen(false)}
      />
    </div>
  );
}
