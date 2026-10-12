import { Button, TextField } from "@pap/ui";
import { t } from "../../i18n/index.ts";
import type { SessionView } from "../../stores/session-reducer.ts";
import { QueueStrip } from "./QueueStrip.tsx";
import { useComposer, type Injected } from "./use-composer.ts";

interface ComposerProps {
  readonly sessionId: string;
  readonly view: SessionView;
  /** Moves focus to an open custom panel; true when it did (Task 27 wires it). */
  readonly onTabToPanel?: () => boolean;
  /** Text "Edit from here" puts in the field; `n` rises with each one, and a text is applied once. */
  readonly injected?: Injected | null;
  /** A navigation or compaction the view does not show is in flight: Stop stays reachable. */
  readonly structuralBusy?: boolean;
}

export function Composer({ sessionId, view, onTabToPanel, injected, structuralBusy }: ComposerProps) {
  const c = useComposer(sessionId, view, {
    injected: injected ?? null,
    structuralBusy: structuralBusy ?? false,
  });
  const blocked = c.pending !== null || c.compacting || c.sending;
  return (
    <div
      data-composer
      className="flex flex-col gap-2"
      onKeyDown={(event) => {
        const plain = !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey;
        if (event.key === "Tab" && plain && onTabToPanel?.()) event.preventDefault();
      }}
    >
      <QueueStrip queue={view.queue} onClear={c.clearQueue} />
      {c.pending ? (
        <div role="status" className="flex items-center gap-2 border-l-2 border-attention-line px-3 py-2">
          <p className="flex-1 text-ui text-fg">{t("sessions.composer.mayHaveBeenSent")}</p>
          <Button variant="primary" disabled={c.resending} onClick={() => void c.sendAgain()}>
            {t("sessions.composer.sendAgain")}
          </Button>
          <Button disabled={c.resending} onClick={c.edit}>
            {t("sessions.composer.edit")}
          </Button>
        </div>
      ) : null}
      {c.note ? (
        <p role="status" aria-live="polite" className="text-ui text-muted">
          {c.note}
        </p>
      ) : null}
      {c.error ? (
        <p role="alert" className="text-ui text-attention">
          {c.error}
        </p>
      ) : null}
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          c.send();
        }}
      >
        <TextField
          label={t("session.composer")}
          value={c.text}
          onChange={c.changeText}
          multiline
          name="message"
          onSubmitShortcut={() => c.send()}
        />
        <div className="flex flex-wrap gap-2">
          {c.running ? (
            <div role="group" aria-label={t("sessions.composer.whenWorking")} className="flex gap-2">
              <Button
                variant={c.behavior === "steer" ? "primary" : "secondary"}
                disabled={blocked || c.text.trim() === ""}
                onClick={() => c.send("steer")}
              >
                {t("sessions.composer.steer")}
              </Button>
              <Button
                variant={c.behavior === "followUp" ? "primary" : "secondary"}
                disabled={blocked || c.text.trim() === ""}
                onClick={() => c.send("followUp")}
              >
                {t("sessions.composer.followUp")}
              </Button>
            </div>
          ) : (
            <Button type="submit" variant="primary" disabled={blocked || c.text.trim() === ""}>
              {t("sessions.composer.send")}
            </Button>
          )}
          {c.canStop ? <Button onClick={c.stop}>{t("sessions.composer.stop")}</Button> : null}
        </div>
      </form>
    </div>
  );
}
