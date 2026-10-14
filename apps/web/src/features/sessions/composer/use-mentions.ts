import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useShellStore } from "../../../stores/shell-store.ts";
import { reportClientIssue } from "../../../lib/report.ts";
import { getRuntime, windowTimers } from "../../../runtime/index.ts";
import type { Timers } from "../../../runtime/connection.ts";
import "./register-files-catalog.ts";
import {
  insertAt,
  insertMention,
  isShowable,
  mentionAt,
  mentionPath,
  mentionText,
  relativePath,
  type Mention,
} from "./mention.vm.ts";
import type { ComposerMenu } from "./menus.ts";

const SEARCH_DEBOUNCE_MS = 150;
const SEARCH_LIMIT = 8;

export interface MentionMenuView {
  readonly id: string;
  readonly items: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly active: number;
  pick(index: number): void;
}

export interface MentionsArgs {
  readonly text: string;
  setText(text: string): void;
  readonly sessionId: string;
  /** Overrides the session's project root, which is what `files.search` is rooted at (its folder when unknown). */
  readonly root?: string;
  /** The session's folder: mentions are written relative to it. */
  readonly folder: string;
  readonly timers?: Timers;
}

/** `@` mentions, as plain text in the message (M8R84, M8R89): the menu follows the caret's `@query`. */
export function useMentions(args: MentionsArgs): ComposerMenu & { readonly menu: MentionMenuView | null } {
  const { text, setText, folder } = args;
  const projectRoot = useShellStore((state) => {
    const projectId = state.view.sessions.get(args.sessionId)?.projectId;
    return projectId ? (state.view.projects.get(projectId)?.root ?? null) : null;
  });
  const root = args.root ?? projectRoot ?? folder;
  const timers = args.timers ?? windowTimers;
  const listId = useId();
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const [mention, setMention] = useState<Mention | null>(null);
  const [paths, setPaths] = useState<readonly string[]>([]);
  const [active, setActive] = useState(0);
  // The mention Escape (or a pick) closed: it stays closed until the query changes.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const caretAfter = useRef<number | null>(null);

  // The caret lands after an inserted mention once React has put the new text in the field.
  useEffect(() => {
    if (caretAfter.current === null) return;
    fieldRef.current?.setSelectionRange(caretAfter.current, caretAfter.current);
    caretAfter.current = null;
  }, [text]);
  useEffect(() => {
    const caret = fieldRef.current?.selectionStart ?? text.length;
    const found = mentionAt(text, caret);
    setMention((shown) => (shown?.start === found?.start && shown?.query === found?.query ? shown : found));
  }, [text]);

  const query = mention?.query ?? "";
  const start = mention?.start ?? -1;
  useEffect(() => {
    if (query === "") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- no mention, no results: nothing else knows when the query ended
      setPaths([]);
      return;
    }
    let live = true;
    const handle = timers.set(() => {
      getRuntime()
        .rpc.call("files.search", { root, query, limit: SEARCH_LIMIT })
        .then(
          (found) => {
            if (!live) return;
            setPaths(found.paths.filter(isShowable));
            setActive(0);
          },
          () => {
            if (!live) return;
            reportClientIssue("mention_search_failed");
            setPaths([]);
          },
        );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      live = false; // an answer still on its way belongs to a query that is gone
      timers.clear(handle);
    };
  }, [query, start, root, timers]);

  const key = mention === null ? null : `${mention.start}:${mention.query}`;
  const open = mention !== null && query !== "" && paths.length > 0 && key !== dismissed;

  const apply = (inserted: { readonly text: string; readonly caret: number }) => {
    caretAfter.current = inserted.caret;
    setMention(null);
    setPaths([]);
    setText(inserted.text);
  };
  const pick = (index: number) => {
    const path = paths[index];
    if (path === undefined || mention === null) return;
    apply(insertMention(text, mention, mentionText(mentionPath(path, root, folder))));
  };
  const close = () => {
    if (key !== null) setDismissed(key);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const plain = !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey;
    const handled = (action: () => void) => {
      event.preventDefault();
      event.stopPropagation();
      action();
    };
    if (event.key === "ArrowDown") handled(() => setActive((active + 1) % paths.length));
    else if (event.key === "ArrowUp") handled(() => setActive((active + paths.length - 1) % paths.length));
    else if ((event.key === "Enter" || event.key === "Tab") && plain) handled(() => pick(active));
    else if (event.key === "Escape") handled(close);
  };

  return {
    open,
    close,
    onKeyDown,
    fieldRef,
    dropPath: (absolute) => {
      const relative = relativePath(folder, absolute);
      // The `@` menu hides these names (isShowable); a dragged row must not carry one into the prompt (MC38 m4).
      if (!isShowable(relative)) return;
      const caret = fieldRef.current?.selectionStart ?? text.length;
      apply(insertAt(text, caret, mentionText(relative)));
    },
    combobox: open ? { expanded: true, controls: listId, activeDescendant: `${listId}-${active}` } : null,
    menu: open
      ? {
          id: listId,
          items: paths.map((path, index) => ({
            id: `${listId}-${index}`,
            label: mentionPath(path, root, folder),
          })),
          active,
          pick,
        }
      : null,
  };
}
