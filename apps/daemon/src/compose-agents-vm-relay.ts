import { dirname, extname, join } from "node:path";
import type { Clock } from "./kernel/clock.ts";
import type { Logger } from "./kernel/logger.ts";
import {
  type ClaudeTokenStore,
  createRelayLink,
  forkRelay,
  type PolicyView,
  relayEnv,
  relayListenOf,
  type OwnerSecretsCollector,
  createStderrRedactor,
  type RelayChild,
  type RelayLink,
} from "./modules/agent-vm/index.ts";

/** Until the late binding the relay learns no model for any agent: it refuses every request (fail closed). */
const failClosed = { policyOf: async () => ({ models: [], claude: false, blocked: null }) as PolicyView };

export interface RelayContext {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly env: NodeJS.ProcessEnv;
  readonly piHostEntry: string;
  readonly piHostExecArgv: readonly string[];
  readonly piAgentDir: string;
  readonly testProviderScript: string | null;
  readonly claudeToken: ClaudeTokenStore;
  /** The owner's values the relay's stderr is masked with (T15b). */
  readonly ownerSecrets: OwnerSecretsCollector;
  /** Under Kata the relay listens on the bridge's host address; under the process backend and test backends on loopback. */
  readonly bridgeAddress: boolean;
  /** `"off"`: no relay child; a `fork`: the test's own child, told where the relay would listen. Default: the real `pap-relay`. */
  readonly relay: "off" | { fork(listen: string): RelayChild } | undefined;
  readonly relayExecArgv: readonly string[] | undefined;
  /** Resolves when the bridge address exists (pap0): the relay is started after it (AVM-P10). Default: at once. */
  readonly bridgeReady: (() => Promise<void>) | undefined;
  readonly late: () => {
    policyOf(agentId: string): Promise<PolicyView>;
    turnsOf(agentId: string): number;
    windowEnded(): void;
  } | null;
}

/** The relay (R13): `pap-relay`, forked after the bridge exists, reading the policy the late binding gives it. */
export function composeRelay(ctx: RelayContext): RelayLink | null {
  if (ctx.relay === "off") return null;
  const listen = relayListenOf(!ctx.bridgeAddress);
  const custom = ctx.relay;
  const relay = createRelayLink({
    fork: custom
      ? () => custom.fork(listen)
      : () =>
          forkRelay({
            entry: join(dirname(ctx.piHostEntry), "relay", `main${extname(ctx.piHostEntry)}`),
            execArgv: ctx.relayExecArgv ?? ctx.piHostExecArgv,
            listen,
            env: relayEnv(ctx.env, ctx.piAgentDir, ctx.testProviderScript),
            clock: ctx.clock,
            logger: ctx.logger,
            redact: createStderrRedactor({ clock: ctx.clock, collect: ctx.ownerSecrets }),
          }),
    clock: ctx.clock,
    logger: ctx.logger,
    ...(ctx.bridgeReady ? { bridgeReady: ctx.bridgeReady } : {}),
    policyOf: (agentId) => (ctx.late() ?? failClosed).policyOf(agentId),
    claudeToken: () => ctx.claudeToken.load(),
    reportedTurns: (agentId) => ctx.late()?.turnsOf(agentId) ?? 0,
    windowEnded: () => ctx.late()?.windowEnded(),
  });
  // The bridge's policy follows the token too: set it and the agents with the bridge may use it at once.
  ctx.claudeToken.onChange((token) => (relay.setClaudeToken(token), relay.refreshAll()));
  return relay;
}
