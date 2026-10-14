import { TERMINAL_LIMITS, TerminalStreamEvent, type TerminalView } from "@pap/contracts";

export interface TerminalsView {
  readonly loaded: boolean;
  readonly terminals: ReadonlyMap<string, TerminalView>;
  /** The same terminals, oldest first: one array per change, so a selector on it does not re-render for nothing. */
  readonly list: readonly TerminalView[];
  /** Events this build could not read: skipped, never fatal. */
  readonly skipped: number;
}

export const EMPTY_TERMINALS: TerminalsView = { loaded: false, terminals: new Map(), list: [], skipped: 0 };

const byAge = (a: TerminalView, b: TerminalView) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1);

/** Past the cap the oldest exited terminals go first, then the oldest of all. */
function bounded(terminals: Map<string, TerminalView>): Map<string, TerminalView> {
  const excess = terminals.size - TERMINAL_LIMITS.listed;
  if (excess <= 0) return terminals;
  const order = [...terminals.values()].sort(
    (a, b) => Number(b.status === "exited") - Number(a.status === "exited") || byAge(a, b),
  );
  for (const terminal of order.slice(0, excess)) terminals.delete(terminal.id);
  return terminals;
}

function viewOf(terminals: Map<string, TerminalView>, skipped: number): TerminalsView {
  return { loaded: true, terminals, list: [...terminals.values()].sort(byAge), skipped };
}

export function reduceTerminals(view: TerminalsView, event: unknown): TerminalsView {
  const parsed = TerminalStreamEvent.safeParse(event);
  if (!parsed.success) return { ...view, skipped: view.skipped + 1 };
  const next = parsed.data;
  if (next.kind === "snapshot") {
    return viewOf(bounded(new Map(next.terminals.map((terminal) => [terminal.id, terminal]))), view.skipped);
  }
  const terminals = new Map(view.terminals);
  if (next.kind === "terminal") terminals.set(next.terminal.id, next.terminal);
  else terminals.delete(next.id);
  return viewOf(bounded(terminals), view.skipped);
}
