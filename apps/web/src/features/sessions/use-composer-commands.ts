import { useNavigate } from "@tanstack/react-router";
import {
  createElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { reportClientIssue } from "../../lib/report.ts";
import { getRuntime } from "../../runtime/index.ts";
import type { ComposerMenu } from "./composer/menus.ts";
import {
  activeTrigger,
  completeCommand,
  pickSkill,
  rowsFor,
  skillPrefix,
  stripSkillPrefix,
  type ListedCommand,
  type Picked,
  type Trigger,
} from "./composer-commands.vm.ts";
import { CommandsMount } from "./CommandsMount.tsx";

export interface ComposerCommandsArgs {
  readonly sessionId: string;
  readonly text: string;
  setText(text: string): void;
  /** The composer field's ref (the one `useMentions` hands out), so the field has a single ref. */
  readonly fieldRef?: RefObject<HTMLTextAreaElement | null> | undefined;
}

export type ComposerCommands = ComposerMenu & { readonly menu: ReactNode };

/** What the user is doing with the menu: Enter and a press act on the row, Tab only completes. */
type Intent = "enter" | "tab" | "press";

/**
 * The `/` command menu and the `$` skill menu (M7R119 to M7R122). The commands are asked for the first time a trigger
 * appears, not when the composer mounts: a cold session's worker starts for the answer. Keys act only while the menu is open.
 */
export function useComposerCommands(args: ComposerCommandsArgs): ComposerCommands {
  const { sessionId, text, setText } = args;
  const navigate = useNavigate();
  const listId = useId();
  const ownRef = useRef<HTMLTextAreaElement | null>(null);
  const fieldRef = args.fieldRef ?? ownRef;
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [listing, setListing] = useState<{
    sessionId: string;
    commands: readonly ListedCommand[];
    truncated: boolean;
  } | null>(null);
  // The listbox is a lazy chunk: its rows (and the id the field points at) exist only once it has rendered.
  const [rendered, setRendered] = useState(false);
  const [active, setActive] = useState<{ key: string; index: number } | null>(null);
  // The token Escape (or a pick) closed: it stays closed until the token changes.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const asked = useRef<string | null>(null);
  const caretAfter = useRef<number | null>(null);

  // The caret lands after a completed command once React has put the new text in the field.
  useEffect(() => {
    if (caretAfter.current === null) return;
    fieldRef.current?.setSelectionRange(caretAfter.current, caretAfter.current);
    caretAfter.current = null;
  }, [text, fieldRef]);
  useEffect(() => {
    const caret = fieldRef.current?.selectionStart ?? text.length;
    const found = activeTrigger(text, caret);
    setTrigger((shown) =>
      shown?.start === found?.start && shown?.query === found?.query && shown?.char === found?.char
        ? shown
        : found,
    );
  }, [text, fieldRef]);

  const wanted = trigger !== null;
  useEffect(() => {
    if (!wanted || asked.current === sessionId) return;
    asked.current = sessionId;
    getRuntime()
      .rpc.call("sessions.commands", { sessionId })
      .then(
        (data) => setListing({ sessionId, commands: data.commands, truncated: data.truncated }),
        () => {
          // Offer nothing; the next trigger asks again.
          asked.current = null;
          reportClientIssue("commands_list_failed");
        },
      );
  }, [wanted, sessionId]);

  const rows = useMemo(
    () =>
      trigger === null ? [] : rowsFor(listing?.sessionId === sessionId ? listing.commands : [], trigger),
    [listing, sessionId, trigger],
  );
  const key = trigger === null ? null : `${trigger.char}${trigger.start}:${trigger.query}`;
  const open = trigger !== null && rows.length > 0 && key !== dismissed;
  const index = open && active?.key === key ? Math.min(active.index, rows.length - 1) : 0;

  const apply = (picked: Picked) => {
    caretAfter.current = picked.caret;
    setTrigger(null);
    setText(picked.text);
  };
  const pick = (at: number, intent: Intent) => {
    const row = rows[at];
    if (row === undefined || trigger === null) return;
    if (row.builtinMcp && intent !== "tab") {
      // Pi's own manager would run in the session; pap has its own screen for it (M7R120).
      setTrigger(null);
      setText("");
      navigate({ to: "/settings/$section", params: { section: "mcp" } }).catch(() =>
        reportClientIssue("command_failed"),
      );
      return;
    }
    apply(
      row.skill === null ? completeCommand(text, trigger, row.name) : pickSkill(text, trigger, row.skill),
    );
  };
  const close = () => {
    if (key !== null) setDismissed(key);
  };
  const move = (to: number) => {
    if (key !== null) setActive({ key, index: (to + rows.length) % rows.length });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open) return;
    const plain = !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey;
    const handled = (action: () => void) => {
      event.preventDefault();
      event.stopPropagation();
      action();
    };
    if (event.key === "ArrowDown") handled(() => move(index + 1));
    else if (event.key === "ArrowUp") handled(() => move(index - 1));
    else if (event.key === "Enter" && plain) handled(() => pick(index, "enter"));
    else if (event.key === "Tab" && plain) handled(() => pick(index, "tab"));
    else if (event.key === "Escape") handled(close);
  };

  const skill = skillPrefix(text);
  return {
    open,
    close,
    onKeyDown,
    fieldRef,
    combobox: open
      ? { expanded: true, controls: listId, activeDescendant: rendered ? `${listId}-${index}` : null }
      : null,
    // eslint-disable-next-line react-hooks/refs -- the handlers read the field's ref when a key or a press calls them, never while rendering
    menu: createElement(CommandsMount, {
      skill,
      removeSkill: () => {
        setText(stripSkillPrefix(text));
        fieldRef.current?.focus();
      },
      open,
      close,
      menu: {
        id: listId,
        skillsOnly: trigger?.char === "$",
        rows,
        truncated: listing?.truncated === true,
        onRendered: setRendered,
        active: index,
        pick: (at) => pick(at, "press"),
      },
    }),
  };
}
