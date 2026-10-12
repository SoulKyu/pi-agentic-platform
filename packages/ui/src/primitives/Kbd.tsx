import { Fragment } from "react";

const KEY_CLASSES = "rounded-sm border border-border-strong bg-surface px-1 font-mono text-label text-muted";

export interface KbdProps {
  readonly keys: readonly string[];
  readonly joiner?: "" | "+";
}

/** A shortcut chip (Orca ShortcutKeyCombo). The caller formats the keys for the platform (Task 16a `chordTokens`). */
// Defaults are read in the body: the React Compiler (Babel 8 AST) bails out on defaults in a destructured parameter.
export function Kbd({ keys, joiner }: KbdProps) {
  const between = joiner ?? "";
  return (
    <kbd data-slot="kbd" className="inline-flex items-center gap-0.5">
      {keys.map((key, index) => (
        <Fragment key={`${index}:${key}`}>
          {index > 0 && between ? between : null}
          <kbd className={KEY_CLASSES}>{key}</kbd>
        </Fragment>
      ))}
    </kbd>
  );
}
