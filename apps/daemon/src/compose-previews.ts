import { type ApprovalMode, type Caller, type BoxRef, PapError, type PreviewDecl } from "@pap/contracts";
import type { BoxOps, BoxTunnels } from "./kernel/boxes.ts";
import { createPreviewListener } from "./kernel/http/preview/listener.ts";
import type { Clock, TimerHandle } from "./kernel/clock.ts";
import type { Config } from "./kernel/config.ts";
import { previewOriginOf } from "./kernel/config-preview.ts";
import { hostAddressesNow } from "./kernel/net/vm-address.ts";
import type { Logger } from "./kernel/logger.ts";
import type { StreamHub } from "./kernel/ws/stream-hub.ts";
import type { PlatformPort } from "./modules/platform/index.ts";
import {
  createBoxOwner,
  createPreviewGrants,
  createPreviewRegistry,
  createPreviewsService,
  createPreviewsStream,
  createPreviewStart,
  createPreviewStop,
  PREVIEW_TOKEN_LIMITS,
  type PreviewRegistry,
  previewsRpc,
  type PreviewsRpc,
  type PreviewsStream,
  type PreviewTokens,
  createPreviewTokens,
  type RegistryRuntime,
} from "./modules/previews/index.ts";

type Closers = Array<{ readonly name: string; close(): void | Promise<void> }>;

export type PreviewsConfig = Pick<
  Config,
  "host" | "tls" | "previewPort" | "previewOrigin" | "publicOrigin" | "allowedOrigins"
>;

/** What the service side of previews reads of the VM stack and the sessions (UX2-R28, R29, R68, R69). */
export interface PreviewServiceDeps {
  /** The registry's view of the runtime, and `touch` for the traffic a live token carries (UX2-R35). */
  readonly runtime: RegistryRuntime & { touch(box: BoxRef): void };
  /** The guest ops of the project boxes and of the agents' VMs. */
  readonly ops: { readonly project: BoxOps; readonly agent: BoxOps };
  readonly tunnels: BoxTunnels;
  readonly platform: Pick<PlatformPort, "register">;
  readonly sessions: {
    projectBoxOf(sessionId: string): { readonly projectId: string } | null;
    shellNetwork(sessionId: string): boolean | null;
    modeOf(ownerId: string, sessionId: string): ApprovalMode;
  };
  readonly owners: { project(projectId: string): string | null; agent(agentId: string): string | null };
  /** The owner's secrets masked in a service's output line. */
  readonly redact: (line: string) => Promise<string>;
  /** The egress list the proxy judges that box with now: an agent's own, else the owner's; a project box's owner list and its own (UX2-R71). */
  readonly hostsOf: (box: BoxRef) => readonly string[] | null;
  /** Hands a fresh read of a project's declaration to the box control, so `projects.box` shows what START PREVIEW compared (I1). */
  readonly notePreview: (projectId: string, decl: PreviewDecl | null, invalid: boolean) => void;
}

/** The late seam (PF-6): what is known only once the sessions and the VM stack exist. Absent parts leave their feature off. */
export interface PreviewsLate {
  /** The transcript read an HTML artifact comes from; always bound, whatever the VM stack (PF-10). */
  readonly entryText: (sessionId: string, entryId: string, caller: Caller) => Promise<string | null>;
  /** Absent without a VM stack: no registry, no platform op, an empty stream, no service token. */
  service?: PreviewServiceDeps;
}

/** What `bind` hands the RPC layer (T10): the registry and its tunnels, the owner of a box, and the stream. */
export interface PreviewsBound {
  /** The ten `previews.*` handlers (and `subscribe.previews`), for the daemon's handler table. */
  readonly rpc: PreviewsRpc;
  readonly registry: PreviewRegistry | null;
  readonly tunnels: BoxTunnels | null;
  readonly ownerOf: (box: BoxRef) => string | null;
  readonly stream: PreviewsStream | null;
}

export interface PreviewsHandle {
  /** The origin the web frames and `previews.open` answers with; null when the listener could not bind. */
  readonly origin: string | null;
  readonly tokens: PreviewTokens;
  /** One call, once the sessions and the VM stack exist: a second throws. */
  bind(late: PreviewsLate): PreviewsBound;
}

/**
 * The untrusted preview listener, bound on the app's host and TLS before the app is built (UX2-R11), so the app's `frame-src`
 * is known. A bind failure is logged once and leaves `origin` null: previews are off and the daemon runs on (spec §9b).
 * Until `bind`, no token is known to the listener.
 */
export async function composePreviews(
  core: {
    config: PreviewsConfig;
    clock: Clock;
    logger: Logger;
    hub?: Pick<StreamHub, "publish" | "registerSnapshot">;
  },
  closers: Closers,
  deps: { tokens?: PreviewTokens } = {},
): Promise<PreviewsHandle> {
  const { config, clock, logger } = core;
  const tokens = deps.tokens ?? createPreviewTokens(clock);
  let grants: ReturnType<typeof createPreviewGrants> | null = null;
  const listener = createPreviewListener({
    appOrigins: [...config.allowedOrigins],
    previewOrigin: (port) => previewOriginOf(config.publicOrigin, port, config.previewOrigin),
    grantOf: (kind, token) => grants?.grantOf(kind, token) ?? null,
    onTraffic: (box) => grants?.onTraffic(box),
    clock,
    logger,
  });
  let origin: string | null = null;
  try {
    const { port } = await listener.listen(config.host, config.previewPort, config.tls);
    origin = previewOriginOf(config.publicOrigin, port, config.previewOrigin);
    closers.push({ name: "preview_listener", close: () => listener.close() });
  } catch (error) {
    logger.warn("preview_listener_unavailable", { code: (error as NodeJS.ErrnoException).code ?? "unknown" });
  }
  if (origin !== null) {
    let timer: TimerHandle | undefined;
    const arm = (): void => {
      timer = clock.setTimeout(() => {
        tokens.sweep();
        arm();
      }, PREVIEW_TOKEN_LIMITS.renewMs);
    };
    arm();
    closers.push({ name: "preview_token_sweep", close: () => timer && clock.clearTimeout(timer) });
  }
  let bound = false;
  return {
    origin,
    tokens,
    bind(next) {
      if (bound) throw new Error("previews are already bound");
      bound = true;
      const service = next.service;
      const registry =
        service === undefined
          ? null
          : createPreviewRegistry({
              runtime: service.runtime,
              ops: service.ops,
              tokens,
              redact: service.redact,
              clock,
              logger: logger.child({ module: "previews" }),
            });
      const stream = core.hub === undefined ? null : createPreviewsStream({ hub: core.hub, registry, clock });
      if (service !== undefined && registry !== null) {
        const ops = {
          registry,
          projectOf: (sessionId: string) => service.sessions.projectBoxOf(sessionId)?.projectId ?? null,
          shellNetwork: (_ownerId: string, sessionId: string) => service.sessions.shellNetwork(sessionId),
          modeNow(ownerId: string, sessionId: string) {
            try {
              return service.sessions.modeOf(ownerId, sessionId);
            } catch {
              // A session the daemon cannot read has no mode to run in.
              return null;
            }
          },
        };
        service.platform.register("preview.start", createPreviewStart(ops));
        service.platform.register("preview.stop", createPreviewStop(ops));
      }
      grants = createPreviewGrants({
        tokens,
        registry,
        tunnels: service?.tunnels ?? null,
        ...(service === undefined ? {} : { touch: (box) => service.runtime.touch(box) }),
      });
      const ownerOf = createBoxOwner(service?.owners ?? { project: () => null, agent: () => null });
      // Every origin is the config's own, already validated.
      const appHosts = [
        config.publicOrigin,
        ...config.allowedOrigins,
        ...(origin === null ? [] : [origin]),
      ].map((text) => new URL(text).hostname);
      const previewsService = createPreviewsService({
        registry,
        tokens,
        origin,
        ownerOf,
        phase: (box) => service?.runtime.phase(box) ?? "stopped",
        hostsOf: (box) => service?.hostsOf(box) ?? null,
        // UX2-R71: pap's own hosts are never admitted into a page; the host's addresses are read when a token is minted.
        ownHosts: () => [...hostAddressesNow(), ...appHosts],
        projectConfig: async (projectId) => {
          if (service === undefined) throw new PapError("box_stopped");
          const { preview, previewInvalid } = await service.ops.project.call(projectId, {
            name: "project.config",
          });
          service.notePreview(projectId, preview, previewInvalid);
          return { preview, previewInvalid };
        },
        entryText: next.entryText,
        logger: logger.child({ module: "previews" }),
      });
      closers.push({
        name: "previews_service",
        close() {
          registry?.close();
          stream?.stop();
        },
      });
      return {
        rpc: previewsRpc(previewsService),
        registry,
        tunnels: service?.tunnels ?? null,
        ownerOf,
        stream,
      };
    },
  };
}
