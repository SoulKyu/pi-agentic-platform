import { Button, TextField } from "@pap/ui";
import { useEffect, useRef } from "react";
import { useT } from "../../i18n/index.ts";
import { useCommand } from "../../lib/use-command.ts";
import type { SessionView } from "../../stores/session-reducer.ts";
import { AttachButton } from "./composer/AttachButton.tsx";
import { AttachmentTray } from "./composer/AttachmentTray.tsx";
import { MentionMenu } from "./composer/MentionMenu.tsx";
import { useComposerFieldProps } from "./composer/menus.ts";
import { useAttachments } from "./composer/use-attachments.ts";
import { useMentions } from "./composer/use-mentions.ts";
import { ModelBar } from "./ModelBar.tsx";
import { useComposerCommands } from "./use-composer-commands.ts";
import { rememberScreen, targetScreen } from "./last-screen.ts";
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
  const t = useT();
  const attachments = useAttachments(sessionId);
  const c = useComposer(sessionId, view, {
    injected: injected ?? null,
    structuralBusy: structuralBusy ?? false,
    attachments,
  });
  const mentions = useMentions({ sessionId, text: c.text, setText: c.changeText, folder: view.cwd });
  const commands = useComposerCommands({
    sessionId,
    text: c.text,
    setText: c.changeText,
    fieldRef: mentions.fieldRef,
  });
  const fieldProps = useComposerFieldProps([mentions, commands], attachments);
  const blocked = c.pending !== null || c.compacting || c.sending;
  const root = useRef<HTMLDivElement | null>(null);
  // Two session screens can be mounted (a split): a key belongs to the one that holds the focus, and a command run from
  // the palette to the one that held it before. With no such screen the latest one answers.
  const ownScreen = () => root.current?.closest("[data-session-screen]") ?? null;
  const mine = () => {
    const target = targetScreen(document.activeElement);
    return target === null || target === ownScreen();
  };
  useEffect(() => {
    const noteFocus = (event: FocusEvent) => {
      const screen = ownScreen();
      if (screen && event.target instanceof Node && screen.contains(event.target)) rememberScreen(screen);
    };
    document.addEventListener("focusin", noteFocus);
    return () => document.removeEventListener("focusin", noteFocus);
  }, []);
  // Escape stops the run like the pi TUI's; the dispatcher already keeps it out of a panel, a menu and an inline edit.
  useCommand("session.stop", () => {
    if (!mine() || !c.canStop) return false;
    c.stop();
  });
  // Mod+Shift+Enter sends this message the other way while the agent works, once: the saved choice is the buttons'.
  useCommand("session.sendOther", () => {
    if (!mine() || !c.canSend) return false;
    c.send(c.running ? (c.behavior === "steer" ? "followUp" : "steer") : undefined, { remember: false });
  });
  return (
    <div
      ref={root}
      data-composer
      className="mx-auto flex w-full max-w-chat flex-col gap-s2"
      // Mod+Shift+Enter belongs to the "send the other way" command alone: the field's own Mod+Enter submit must not
      // also send it the default way when the command declines (a menu or a dialog is open).
      onKeyDownCapture={(event) => {
        if (event.key === "Enter" && event.shiftKey && (event.ctrlKey || event.metaKey))
          event.stopPropagation();
      }}
      onKeyDown={(event) => {
        const plain = !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey;
        if (event.key === "Tab" && plain && onTabToPanel?.()) event.preventDefault();
      }}
    >
      <QueueStrip queue={view.queue} onClear={c.clearQueue} />
      {c.pending ? (
        <div role="status" className="flex items-center gap-s2 border-l-2 border-attn-line px-s3 py-s2">
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
        <p role="alert" className="text-ui text-attn">
          {c.error}
        </p>
      ) : null}
      <form
        className="flex flex-col gap-s2"
        onSubmit={(event) => {
          event.preventDefault();
          c.send();
        }}
      >
        <AttachmentTray attachments={attachments} />
        <TextField
          label={t("session.composer")}
          value={c.text}
          onChange={c.changeText}
          multiline
          ground="surface"
          name="message"
          onSubmitShortcut={() => c.send()}
          {...fieldProps}
        />
        <MentionMenu menu={mentions.menu} />
        {commands.menu}
        <div className="flex flex-wrap gap-s2">
          <ModelBar sessionId={sessionId} loadout={view.loadout} running={c.running} />
          {c.running ? (
            <div role="group" aria-label={t("sessions.composer.whenWorking")} className="flex gap-s2">
              <Button
                variant={c.behavior === "steer" ? "primary" : "secondary"}
                disabled={blocked || !c.canSend}
                onClick={() => c.send("steer")}
              >
                {t("sessions.composer.steer")}
              </Button>
              <Button
                variant={c.behavior === "followUp" ? "primary" : "secondary"}
                disabled={blocked || !c.canSend}
                onClick={() => c.send("followUp")}
              >
                {t("sessions.composer.followUp")}
              </Button>
            </div>
          ) : (
            <Button type="submit" variant="primary" disabled={blocked || !c.canSend}>
              {t("sessions.composer.send")}
            </Button>
          )}
          <AttachButton attachments={attachments} />
          {c.canStop ? <Button onClick={c.stop}>{t("sessions.composer.stop")}</Button> : null}
        </div>
      </form>
    </div>
  );
}
