import { randomBytes } from "node:crypto";
import { PapError } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import { within } from "../../kernel/fs/boundary.ts";
import { readFileSync } from "node:fs";
import { parseProcStat, ptyKill, type PtyTarget } from "../../kernel/pty/kill.ts";
import type { PtyProcess } from "../../kernel/pty/spawn.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { WorkerScope } from "../../kernel/supervisor/scope.ts";
import { createTerminal, type Terminal, type TerminalState } from "./terminal.ts";

/** Exited terminals kept per owner for their output; the oldest one is dropped first (M8R60). */
export const MAX_EXITED_KEPT = 8;

export type TerminalChange = { kind: "terminal"; view: TerminalState } | { kind: "closed"; id: string };

export interface TerminalRegistry {
  /** Throws `capacity` past `maxTerminals` running ones for this owner or under the free-memory floor; never kills one. */
  create(input: {
    ownerId: string;
    cwd: string;
    sessionId: string | null;
    cols: number;
    rows: number;
  }): Terminal;
  /** Null for another owner's terminal. */
  get(ownerId: string, id: string): Terminal | null;
  list(ownerId: string): readonly Terminal[];
  /** The owner's running terminals whose folder is `folder` or below (the archive of a lane refuses while one runs). */
  runningIn(ownerId: string, folder: string): number;
  onChange(listener: (ownerId: string, change: TerminalChange) => void): () => void;
  /** True from the start of `closeAll`: a stopping daemon takes no new shell (MC28). */
  readonly closing: boolean;
  closeAll(): Promise<void>;
}

export interface TerminalRegistryDeps {
  readonly clock: Clock;
  readonly logger: Logger;
  /** `PAP_MAX_TERMINALS`: running terminals per owner (1-64). */
  readonly maxTerminals: number;
  readonly minFreeMemMb: number;
  freeMemMb(): number;
  /** Starts the shell: Task 12 builds the spec (`ptySpec` with the sessions module's `workerUmask`) and spawns it. */
  launch(input: { cwd: string; cols: number; rows: number }): {
    readonly pty: PtyProcess;
    readonly scope: Pick<WorkerScope, "reap"> | null;
  };
  /** Defaults to the kernel's kill ladder. */
  kill?(target: PtyTarget): Promise<void>;
  /** Whether a PTY's shell is still running; defaults to a /proc start-time check. */
  alive?(pty: PtyProcess): boolean;
}

/** The shell's /proc start time still equals the one read at spawn. Without /proc (start null) nobody can tell: alive. */
export function shellAlive(pty: PtyProcess): boolean {
  if (pty.start === null) return true;
  try {
    return parseProcStat(pty.pid, readFileSync(`/proc/${pty.pid}/stat`, "utf8"))?.start === pty.start;
  } catch {
    return false;
  }
}

export function createTerminalRegistry(deps: TerminalRegistryDeps): TerminalRegistry {
  const { logger } = deps;
  const kill =
    deps.kill ??
    ((target: PtyTarget) =>
      ptyKill(target, {
        clock: deps.clock,
        warn: (event, fields) => logger.warn(event, fields),
      }));
  const byOwner = new Map<string, Map<string, Terminal>>();
  /** Per owner, the ids of the exited terminals in the order their shells ended. */
  const exitOrder = new Map<string, string[]>();
  let closing = false;
  const listeners = new Set<(ownerId: string, change: TerminalChange) => void>();

  const emit = (ownerId: string, change: TerminalChange): void => {
    for (const listener of [...listeners]) {
      try {
        listener(ownerId, change);
      } catch (error) {
        logger.error("terminal_listener_failed", { err: error });
      }
    }
  };

  /** Takes the terminal out of the registry and tells the listeners, once. */
  const forget = (ownerId: string, id: string): void => {
    const owned = byOwner.get(ownerId);
    if (!owned?.delete(id)) return;
    if (owned.size === 0) byOwner.delete(ownerId);
    const order = exitOrder.get(ownerId)?.filter((other) => other !== id) ?? [];
    if (order.length > 0) exitOrder.set(ownerId, order);
    else exitOrder.delete(ownerId);
    emit(ownerId, { kind: "closed", id });
  };

  const dropOldestExited = (ownerId: string): void => {
    for (;;) {
      const order = exitOrder.get(ownerId) ?? [];
      if (order.length <= MAX_EXITED_KEPT) return;
      const id = order[0];
      const terminal = id === undefined ? undefined : byOwner.get(ownerId)?.get(id);
      if (id === undefined || !terminal) {
        order.shift();
        continue;
      }
      forget(ownerId, id);
      terminal.close().catch((error: unknown) => {
        logger.error("terminal_close_failed", { terminalId: id, err: error });
      });
    }
  };

  return {
    get closing() {
      return closing;
    },
    create(input) {
      if (closing) throw new PapError("capacity");
      const owned = byOwner.get(input.ownerId);
      const running = [...(owned?.values() ?? [])].filter((t) => t.view().status === "running").length;
      if (running >= deps.maxTerminals) throw new PapError("capacity");
      if (deps.freeMemMb() < deps.minFreeMemMb) throw new PapError("capacity");
      const launched = deps.launch({ cwd: input.cwd, cols: input.cols, rows: input.rows });
      const id = randomBytes(16).toString("base64url");
      const terminal = createTerminal({
        id,
        ownerId: input.ownerId,
        cwd: input.cwd,
        sessionId: input.sessionId,
        cols: input.cols,
        rows: input.rows,
        pty: launched.pty,
        scope: launched.scope,
        clock: deps.clock,
        logger,
        kill,
        alive: () => (deps.alive ?? shellAlive)(launched.pty),
        changed: (view) => emit(input.ownerId, { kind: "terminal", view }),
        exited: () => {
          if (!byOwner.get(input.ownerId)?.has(id)) return;
          exitOrder.set(input.ownerId, [...(exitOrder.get(input.ownerId) ?? []), id]);
          dropOldestExited(input.ownerId);
        },
        closed: () => forget(input.ownerId, id),
      });
      const mine = byOwner.get(input.ownerId) ?? new Map<string, Terminal>();
      mine.set(id, terminal);
      byOwner.set(input.ownerId, mine);
      emit(input.ownerId, { kind: "terminal", view: terminal.view() });
      return terminal;
    },
    get: (ownerId, id) => byOwner.get(ownerId)?.get(id) ?? null,
    list: (ownerId) => [...(byOwner.get(ownerId)?.values() ?? [])],
    runningIn: (ownerId, folder) =>
      [...(byOwner.get(ownerId)?.values() ?? [])].filter(
        (terminal) => terminal.view().status === "running" && within(folder, terminal.cwd),
      ).length,
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    async closeAll() {
      closing = true;
      const all = [...byOwner.values()].flatMap((owned) => [...owned.values()]);
      await Promise.all(
        all.map((terminal) =>
          terminal.close().catch((error: unknown) => {
            logger.error("terminal_close_failed", { terminalId: terminal.id, err: error });
          }),
        ),
      );
    },
  };
}
