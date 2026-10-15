import "./register-lanes-catalog.ts";
import { Banner, Button } from "@pap/ui";
import { plural, useLocale, useT } from "../../i18n/index.ts";
import { escapeHidden } from "../../lib/escape-hidden.ts";
import { useCheckpoint } from "./checkpoint.vm.ts";

/**
 * "Files differ from this point" above the composer (board 10, DESIGN §9.2): Undo and Restore files, asked inline and
 * never a modal. It exists in the browser only: restore needs `lanes:admin`, which a token never holds.
 */
export function CheckpointBanner({
  laneId,
  sessionId,
}: {
  readonly laneId: string;
  readonly sessionId: string;
}) {
  const t = useT();
  const locale = useLocale();
  const checkpoint = useCheckpoint(laneId, sessionId);
  if (!checkpoint.visible) return null;
  const differs = checkpoint.status?.differs === true;
  const left = checkpoint.left;
  const note =
    left !== null
      ? plural(locale, "lanes.checkpoint.restoredPartial", left.total)
      : checkpoint.note === null
        ? null
        : t(checkpoint.note);
  const kept =
    left === null ? null : (
      <ul className="font-mono text-code" data-slot="restore-left">
        {left.paths.map((path) => (
          <li key={path}>{escapeHidden(path)}</li>
        ))}
        {left.total > left.paths.length ? <li>…</li> : null}
      </ul>
    );
  const actions = checkpoint.asking ? (
    <>
      <Button variant="primary" size="sm" disabled={checkpoint.working} onClick={checkpoint.restore}>
        {t("lanes.checkpoint.askYes")}
      </Button>
      <Button size="sm" disabled={checkpoint.working} onClick={checkpoint.cancel}>
        {t("lanes.checkpoint.askNo")}
      </Button>
    </>
  ) : (
    <>
      {checkpoint.canUndo ? (
        <Button size="sm" disabled={checkpoint.working} onClick={checkpoint.undo}>
          {t("lanes.checkpoint.undo")}
        </Button>
      ) : null}
      {differs ? (
        <Button size="sm" disabled={checkpoint.working} onClick={checkpoint.ask}>
          {t("lanes.checkpoint.restore")}
        </Button>
      ) : null}
      {note !== null ? (
        <Button variant="ghost" size="sm" onClick={checkpoint.dismiss}>
          {t("lanes.checkpoint.dismiss")}
        </Button>
      ) : null}
    </>
  );
  return (
    <Banner
      tone="checkpoint"
      title={differs || note === null ? t("lanes.checkpoint.title") : note}
      actions={actions}
    >
      {checkpoint.asking ? (
        t("lanes.checkpoint.ask")
      ) : differs ? (
        <>
          {note}
          {kept}
        </>
      ) : (
        kept
      )}
    </Banner>
  );
}
