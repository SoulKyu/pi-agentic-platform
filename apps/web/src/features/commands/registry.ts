// eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- handlers may return nothing; only false declines
export type CommandHandler = () => boolean | void;

// One stack per command id; entries exist only while the component that registered them is mounted.
const handlers = new Map<string, Array<{ readonly handler: CommandHandler }>>();

export function registerCommand(id: string, handler: CommandHandler): () => void {
  const entry = { handler };
  const stack = handlers.get(id) ?? [];
  stack.push(entry);
  handlers.set(id, stack);
  return () => {
    const current = handlers.get(id);
    if (!current) return;
    const index = current.indexOf(entry);
    if (index === -1) return;
    current.splice(index, 1);
    if (current.length === 0) handlers.delete(id);
  };
}

/** True when a handler claimed the command (it returned anything but false): the latest is asked first, then the earlier ones. */
export function runCommand(id: string): boolean {
  const stack = handlers.get(id) ?? [];
  for (const entry of [...stack].reverse()) if (entry.handler() !== false) return true;
  return false;
}

export const hasCommand = (id: string): boolean => (handlers.get(id)?.length ?? 0) > 0;
