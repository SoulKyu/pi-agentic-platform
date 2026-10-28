import { createContext, useSyncExternalStore } from "react";
import { IconTerminal } from "../../icons.ts";
import { Button } from "../../primitives/Button.tsx";
import { Icon } from "../../primitives/Icon.tsx";
import { InlineError } from "../../primitives/InlineError.tsx";
import { CodeBlock, type CodeCopyLabels } from "./CodeBlock.tsx";
import type { ShellHandOff } from "./reply-tools.ts";

export const ShellHandOffContext = createContext<ShellHandOff | undefined>(undefined);

/**
 * A shell fence with TO TERMINAL under its code block (the block and its copy corner are CodeBlock's, unchanged).
 * The button types the block into the session's terminal; nothing runs before the owner presses Enter there.
 */
export function ShellBlock({
  code,
  lang,
  labels,
  handOff,
}: {
  readonly code: string;
  readonly lang: string;
  readonly labels?: CodeCopyLabels;
  readonly handOff: ShellHandOff;
}) {
  const status = useSyncExternalStore(handOff.subscribe, () => handOff.statusOf(code, lang));
  const block = <CodeBlock code={code} lang={lang} labels={labels} />;
  if (!handOff.canSend(code, lang)) return block;
  return (
    <div data-shell-block="" className="flex flex-col gap-s1">
      {block}
      <div className="flex flex-wrap items-center justify-end gap-s2">
        {status.answer?.ok === true ? (
          <p role="status" aria-live="polite" className="min-w-0 text-ui text-muted">
            {status.answer.text}
          </p>
        ) : null}
        {status.answer?.ok === false ? (
          <InlineError announce="action">{status.answer.text}</InlineError>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          pendingSince={status.since}
          onClick={() => {
            // send never rejects (ShellHandOff.send); the catch keeps a broken port from becoming an unhandled rejection.
            handOff.send(code, lang).catch(() => undefined);
          }}
        >
          <Icon icon={IconTerminal} size={14} />
          {handOff.label}
        </Button>
      </div>
    </div>
  );
}
