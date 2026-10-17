import { join } from "node:path";
import type { EgressStatus } from "@pap/contracts";
import { createSystemClock } from "../../../kernel/clock.ts";
import { silentLogger } from "../../../kernel/logger.ts";
import { type CommandListener, createProxy, type EgressPort, writeForwarder } from "../index.ts";
import { loopbackBed } from "./loopback.ts";

/**
 * TEST ONLY (M11R244): the port the sessions module sees, over a proxy that reaches local origins through `loopbackBed`.
 * Sockets live in `dir` (one folder level, no session folders). Imported by `*.int.test.ts` files; production builds `createEgress`.
 */
export function loopbackEgress(options: {
  readonly dir: string;
  readonly names: Readonly<Record<string, Readonly<Record<number, number>>>>;
  readonly status: EgressStatus;
}): EgressPort & { readonly open: () => number } {
  const proxy = createProxy({
    clock: createSystemClock(),
    logger: silentLogger,
    ...loopbackBed(options.names),
  });
  const forwarder = writeForwarder(options.dir);
  const sessions = new Map<string, Map<string, CommandListener>>();
  let counter = 0;
  const keyOf = (by: { readonly sessionId: string | null; readonly agentId: string } | string): string =>
    typeof by === "string" ? by : (by.sessionId ?? `pre:${by.agentId}`);
  return {
    ready: async () => {},
    recheck: async () => {},
    status: () => options.status,
    forwarderPath: forwarder,
    open: () => [...sessions.values()].reduce((sum, commands) => sum + commands.size, 0),
    async openCommand(scope) {
      const id = (counter++).toString(36);
      const socket = join(options.dir, `${id}.s`);
      const listener = await proxy.listen(socket, scope);
      const key = keyOf(scope);
      sessions.set(key, (sessions.get(key) ?? new Map()).set(id, listener));
      return { id, socket };
    },
    async closeCommand(by, id) {
      const commands = sessions.get(keyOf(by));
      const listener = commands?.get(id);
      commands?.delete(id);
      return listener ? listener.close() : { hosts: [], truncated: true, up: 0, down: 0 };
    },
    shutdown: async () => {},
    async dropSession(key) {
      for (const listener of sessions.get(key)?.values() ?? []) await listener.close();
      sessions.delete(key);
    },
  };
}
