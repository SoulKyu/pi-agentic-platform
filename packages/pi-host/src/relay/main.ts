// Must stay first: closes the inherited pty descriptors before anything else is evaluated (MC29).
import "../close-inherited-fds.ts";
import { homedir } from "node:os";
import { RelayCommand, type RelayReport as RelayReportSchema } from "@pap/contracts";
import type { z } from "zod";
import { createProviderResolver, openRelaySource } from "./credentials.ts";
import { createRelayKeys } from "./keys.ts";
import { createRelayPolicy } from "./policy.ts";
import { createRelayServer, listenOn, parseListen } from "./server.ts";
import { createUsage, type RelayClock } from "./usage.ts";

/**
 * `pap-relay`, the daemon's provider relay child (R13, R34): the only process that holds provider credentials. The daemon
 * (J1) forks it with `--listen <host>:<port>` (the bridge address, or `127.0.0.1:0` for the process backend) and Pi's
 * agent folder in `PI_CODING_AGENT_DIR`, then speaks `RelayCommand`s over IPC. A wildcard address stops it at boot.
 * Nothing it logs holds a key, a token, a path or a host.
 */
const log = (line: string): void => void process.stderr.write(`pap-relay: ${line}\n`);
const fail = (code: number, message: string): never => {
  log(message);
  process.exit(code);
};

const flag = process.argv.indexOf("--listen");
let listen: { host: string; port: number };
if (flag < 0) fail(64, "usage: --listen <bridge address or 127.0.0.1>:<port> (never a wildcard address)");
try {
  listen = parseListen(process.argv[flag + 1] ?? "");
} catch {
  listen = fail(64, "usage: --listen <bridge address or 127.0.0.1>:<port> (never a wildcard address)");
}
const send = process.send?.bind(process);
if (!send) fail(70, "needs an IPC channel: start it with child_process.fork");
const agentDir = process.env.PI_CODING_AGENT_DIR;
if (!agentDir) fail(70, "PI_CODING_AGENT_DIR is not set");

// The IPC channel is the daemon's: when it goes, the relay and its keys go with it.
process.on("disconnect", () => process.exit(1));
process.on("SIGTERM", () => process.exit(0));
process.on("error", () => {});

const clock: RelayClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};
const report = (record: z.infer<typeof RelayReportSchema>): void => void send?.(record);
const keys = createRelayKeys();
const policy = createRelayPolicy();
const usage = createUsage(clock, report);
let claudeToken: string | null = null;

const server = createRelayServer({
  keys,
  policy,
  usage,
  resolveProvider: createProviderResolver({
    open: openRelaySource({ agentDir: agentDir ?? "", home: homedir() }),
    clock,
    testLoopback: process.env.PAP_TEST_PROVIDER_SCRIPT !== undefined,
  }),
  claudeToken: () => claudeToken,
  log,
});

/** The type of a command that did not parse, when it is a short plain word: nothing else of it is kept. */
const typeOf = (raw: unknown): string => {
  const type = (raw as { type?: unknown } | null)?.type;
  return typeof type === "string" && /^[a-z_]{1,32}$/.test(type) ? type : "unknown";
};

process.on("message", (raw: unknown) => {
  const parsed = RelayCommand.safeParse(raw);
  if (!parsed.success) return log(`command_dropped ${JSON.stringify({ type: typeOf(raw) })}`);
  const command = parsed.data;
  switch (command.type) {
    case "relay_grant":
      keys.add({
        launchId: command.launchId,
        agentId: command.agentId,
        key: Buffer.from(command.key, "hex"),
        address: command.address,
      });
      break;
    case "relay_revoke":
      keys.remove(command.launchId);
      break;
    case "agent_policy":
      policy.set(command);
      break;
    case "claude_token":
      claudeToken = command.token;
      break;
  }
});

try {
  const port = await listenOn(server, listen.host, listen.port);
  usage.start();
  report({ type: "relay_ready", port });
} catch (error) {
  // The class only (EADDRINUSE, EADDRNOTAVAIL...): the daemon logs this line, and it names no address, path or key.
  const code = (error as { code?: unknown } | null)?.code;
  fail(
    70,
    `could not listen (${typeof code === "string" && /^[A-Z0-9_]{1,24}$/.test(code) ? code : "error"})`,
  );
}
