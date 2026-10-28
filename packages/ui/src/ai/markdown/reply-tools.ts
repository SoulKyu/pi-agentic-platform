/** One path found in a text: `[start, end)` are UTF-16 offsets into that text; `path` is where the app opens it. */
export interface LinkedSpan {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly path: string;
  readonly line: number | null;
}

/** What a reply may do with the paths it names; the app supplies it, the renderer knows nothing of sessions or folders. */
export interface PathLinks {
  /** Pure; spans in order, never overlapping. `whole`: the text must be exactly one path (inline code). */
  find(text: string, whole: boolean): readonly LinkedSpan[];
  open(span: LinkedSpan): void;
  /** "Open <path> in Files". */
  label(span: LinkedSpan): string;
}

/** The fence languages that get TO TERMINAL, compared lower-cased. */
export const SHELL_LANGS: ReadonlySet<string> = new Set(["bash", "sh", "shell", "zsh", "console"]);

/** Where a block's hand-off stands: `since` is when the click started (null when none runs), `answer` the last result. */
export interface ShellStatus {
  readonly since: number | null;
  readonly answer: { readonly ok: boolean; readonly text: string } | null;
}

/** What a finished reply may do with a shell block: type it into the session's terminal. Nothing runs before the owner presses Enter. */
export interface ShellHandOff {
  /** "To terminal". */
  readonly label: string;
  /** False where the block has nothing to type (empty after the app's cleaning): no button. */
  canSend(code: string, lang: string): boolean;
  /** The app keeps the status (opening the terminal splits the tab, and a phone swaps panes, so the chat mounts again): the block reads it as an external store. */
  subscribe(onChange: () => void): () => void;
  /** The block's current status; the same object until it changes. */
  statusOf(code: string, lang: string): ShellStatus;
  /** Types the block; the status goes busy, then to the answer (`ok`: typed). Never rejects: a failure is an answer in the status. */
  send(code: string, lang: string): Promise<void>;
}
