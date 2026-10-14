import { stat } from "node:fs/promises";
import {
  type BinaryChannel,
  type Caller,
  PapError,
  type ParamsOf,
  type ResultOf,
  TERMINAL_LIMITS,
  type TerminalStreamEvent,
} from "@pap/contracts";
import { type BoundaryConfig, judgePath, type Scope } from "../../kernel/fs/boundary.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { StreamHub } from "../../kernel/ws/stream-hub.ts";
import { MAX_EXITED_KEPT, type TerminalRegistry } from "./registry.ts";

export interface TerminalServiceDeps {
  /** The caller's project roots (M8R15). */
  roots(ownerId: string): readonly string[];
  readonly boundary: BoundaryConfig;
  readonly registry: TerminalRegistry;
  readonly hub: Pick<StreamHub, "registerSnapshot" | "publish">;
  readonly logger: Logger;
  /** `PAP_MAX_TERMINALS`: bounds the remembered request ids with the terminals they name. */
  readonly maxTerminals: number;
}

export interface TerminalService {
  create(caller: Caller, params: ParamsOf<"terminal.create">): Promise<string>;
  attach(
    caller: Caller,
    connectionId: string,
    binary: BinaryChannel | undefined,
    params: ParamsOf<"terminal.attach">,
  ): ResultOf<"terminal.attach">;
  detach(caller: Caller, connectionId: string, streamId: number): void;
  resize(caller: Caller, params: ParamsOf<"terminal.resize">): void;
  close(caller: Caller, terminalId: string): Promise<void>;
}

/** A create in flight or done: the id is known once the shell started. */
interface Request {
  readonly task: Promise<string>;
  readonly id: string | null;
}

export function createTerminalService(deps: TerminalServiceDeps): TerminalService {
  const { registry, logger } = deps;
  /** Per owner: the client's request id → its terminal, for as long as that terminal is listed (M8R64). */
  const requests = new Map<string, Map<string, Request>>();

  const snapshot = (ownerId: string): TerminalStreamEvent => ({
    kind: "snapshot",
    terminals: registry
      .list(ownerId)
      .map((terminal) => terminal.view())
      .slice(0, TERMINAL_LIMITS.listed),
  });
  deps.hub.registerSnapshot("terminal", (ownerId) => snapshot(ownerId));

  registry.onChange((ownerId, change) => {
    if (change.kind === "closed") {
      const mine = requests.get(ownerId);
      for (const [requestId, request] of [...(mine ?? [])])
        if (request.id === change.id) mine?.delete(requestId);
      if (mine?.size === 0) requests.delete(ownerId);
    }
    const event: TerminalStreamEvent =
      change.kind === "terminal"
        ? { kind: "terminal", terminal: change.view }
        : { kind: "closed", id: change.id };
    deps.hub.publish("terminal", ownerId, event);
  });

  /** M8R63: an existing folder inside the caller's roots that the boundary lets them list; anything else is `not_found`. */
  async function judgeFolder(caller: Caller, cwd: string): Promise<string> {
    const scope: Scope = { roots: deps.roots(caller.userId), config: deps.boundary, caller: caller.kind };
    const judgement = await judgePath(cwd, scope, "list");
    if (!judgement.ok) {
      logger.debug("terminal_cwd_refused", { why: judgement.why });
      throw new PapError("not_found");
    }
    const isFolder = await stat(judgement.real).then(
      (info) => info.isDirectory(),
      () => false,
    );
    if (!isFolder) throw new PapError("not_found");
    return judgement.real;
  }

  const mineOrNull = (caller: Caller, terminalId: string) => registry.get(caller.userId, terminalId);

  return {
    async create(caller, params) {
      const owner = caller.userId;
      if (registry.closing) throw new PapError("capacity");
      const known = requests.get(owner)?.get(params.requestId);
      if (known) {
        const id = await known.task;
        if (registry.get(owner, id)) return id;
      }
      const mine = requests.get(owner) ?? new Map<string, Request>();
      if (mine.size >= deps.maxTerminals + MAX_EXITED_KEPT) throw new PapError("capacity");
      requests.set(owner, mine);
      let started: string | null = null;
      const task = (async () => {
        const cwd = await judgeFolder(caller, params.cwd);
        const terminal = registry.create({
          ownerId: owner,
          cwd,
          sessionId: params.sessionId ?? null,
          cols: params.cols,
          rows: params.rows,
        });
        started = terminal.id;
        return terminal.id;
      })();
      const request: Request = {
        task,
        get id() {
          return started;
        },
      };
      mine.set(params.requestId, request);
      try {
        return await request.task;
      } catch (error) {
        if (mine.get(params.requestId) === request) mine.delete(params.requestId);
        if (mine.size === 0 && requests.get(owner) === mine) requests.delete(owner);
        throw error;
      }
    },
    attach(caller, connectionId, binary, { terminalId, after }) {
      const terminal = mineOrNull(caller, terminalId);
      if (!terminal) throw new PapError("not_found");
      if (!binary) throw new PapError("internal");
      const { streamId, start, end, cols, rows, status } = terminal.attach(
        connectionId,
        (sink) => binary.open(sink),
        after,
      );
      return { streamId, start, end, cols, rows, status };
    },
    detach(caller, connectionId, streamId) {
      for (const terminal of registry.list(caller.userId)) terminal.detach(connectionId, streamId);
    },
    resize(caller, { terminalId, cols, rows }) {
      const terminal = mineOrNull(caller, terminalId);
      if (!terminal) throw new PapError("not_found");
      terminal.resize(cols, rows);
    },
    async close(caller, terminalId) {
      await mineOrNull(caller, terminalId)?.close();
    },
  };
}
