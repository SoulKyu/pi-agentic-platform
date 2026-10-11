// eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- handlers may return nothing; only false declines
export type CommandHandler = () => boolean | void;

// One stack per command id; entries exist only while the component that registered them is mounted.
const handlers = new Map<string, Array<{ readonly handler: CommandHandler }>>();
const listeners = new Set<() => void>();
const changed = () => [...listeners].forEach((listener) => listener());

export function registerCommand(id: string, handler: CommandHandler): () => void {
  const entry = { handler };
  const stack = handlers.get(id) ?? [];
  stack.push(entry);
  handlers.set(id, stack);
  changed();
  return () => {
    const current = handlers.get(id);
    if (!current) return;
    const index = current.indexOf(entry);
    if (index === -1) return;
    current.splice(index, 1);
    if (current.length === 0) handlers.delete(id);
    changed();
  };
}

/** True when the latest handler claimed the command (it returned anything but false). */
export function runCommand(id: string): boolean {
  const entry = handlers.get(id)?.at(-1);
  return entry ? entry.handler() !== false : false;
}

export const hasCommand = (id: string): boolean => (handlers.get(id)?.length ?? 0) > 0;

export function onRegistryChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
