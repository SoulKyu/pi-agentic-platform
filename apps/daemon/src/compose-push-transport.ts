import { PROJECT_URL } from "@pap/contracts";
import { join } from "node:path";
import { pushReadiness } from "./kernel/push-readiness.ts";
import {
  bootTransport,
  createHttpsTransport,
  createPushMeta,
  createTransportService,
  hostRules,
  loadVapid,
  type PushDeps,
  type PushSeams,
  type PushTransport,
  type SessionLive,
  type SubscriptionsPort,
  type VapidState,
  type TransportRpc,
  transportRpc,
} from "./modules/push/index.ts";

/** What the transport side hands the delivery side: the three ports of `modules/push/service.ts`, and its own RPC methods. */
export interface TransportSide {
  readonly transport: PushTransport;
  readonly subscriptions: SubscriptionsPort;
  readonly sessionLive: SessionLive;
  readonly rpc: TransportRpc;
}

/** M12R5: PAP_PUSH_SUBJECT, else an https PAP_PUBLIC_ORIGIN, else the project URL (never a made-up mailto:). */
function vapidSubject(config: PushDeps["config"]): string {
  if (config.pushSubject !== null) return config.pushSubject;
  try {
    const origin = new URL(config.publicOrigin);
    if (origin.protocol === "https:") return origin.origin;
  } catch {
    /* an unparsable origin falls through to the project URL; readiness reports it */
  }
  return PROJECT_URL;
}

/**
 * Chain A's side of the push composition (tasks 3 to 7): VAPID keys, the subscriptions and their RPC, and the guarded
 * HTTPS sender. A read-only database boots nothing: no key is minted and no row purged (M12R39). The test bed's seams
 * replace what they name.
 */
export function composeTransportSide(deps: PushDeps, seams: PushSeams = {}): TransportSide {
  const { config } = deps;
  // a boolean only: the readiness never sees the certificate or the key (W6-R8)
  const readiness = {
    publicOrigin: config.publicOrigin,
    tls: config.tls !== null,
    insecureHttp: config.insecureHttp,
  };
  // After prepareHome and the instance lock (the daemon runs composePush late). A read-only database mints nothing.
  const vapid: VapidState | null = deps.readOnly
    ? null
    : loadVapid(join(config.home, "secrets"), deps.logger);
  const hosts = hostRules(config.pushExtraHosts); // one list for subscribing and for sending
  const subscriptions = bootTransport({
    vapid,
    db: deps.db,
    clock: deps.clock,
    logger: deps.logger,
    hosts,
    loopbackForTests: config.testPushLoopback,
  });
  const transport: PushTransport =
    seams.transport ??
    createHttpsTransport({
      vapid,
      subject: vapidSubject(config),
      readiness: pushReadiness(readiness),
      clock: deps.clock,
      logger: deps.logger,
      loopbackForTests: config.testPushLoopback,
      hosts,
    });
  const service = createTransportService({
    store: subscriptions,
    meta: createPushMeta(deps.db),
    transport,
    readiness,
    clock: deps.clock,
    audit: deps.audit.port,
    logger: deps.logger,
    readOnly: deps.readOnly,
  });
  return {
    transport,
    subscriptions: seams.subscriptions ?? subscriptions,
    sessionLive: seams.sessionLive ?? {
      sessionLive: (ownerId, credentialId) => deps.auth.sessionLive(ownerId, credentialId),
    },
    rpc: transportRpc(service),
  };
}
