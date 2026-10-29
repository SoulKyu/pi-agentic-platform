import {
  type BoxRef,
  boxKey,
  type Caller,
  PapError,
  type PreviewDecl,
  type PreviewView,
  type ServiceView,
} from "@pap/contracts";
import { hostSources } from "../../kernel/http/preview/csp.ts";
import type { Logger } from "../../kernel/logger.ts";
import { htmlFenceBody } from "./artifacts.ts";
import type { PreviewRegistry } from "./registry.ts";
import { PREVIEW_TOKEN_LIMITS, type PreviewTokens } from "./tokens.ts";

export interface PreviewsService {
  list(caller: Caller, box: BoxRef): Promise<{ services: PreviewView[] }>;
  stop(caller: Caller, box: BoxRef, name: string): Promise<void>;
  restart(caller: Caller, box: BoxRef, name: string): Promise<{ service: PreviewView }>;
  /** UX2-R74: starts the fresh declaration only when its command and port are what the page showed; `conflict` otherwise. */
  startProject(
    caller: Caller,
    input: { projectId: string; command: string; port: number },
  ): Promise<{ service: PreviewView }>;
  logs(caller: Caller, box: BoxRef, name: string): Promise<{ lines: string[] }>;
  open(caller: Caller, box: BoxRef, name: string): Promise<{ url: string; lease: string; leaseMs: number }>;
  renew(caller: Caller, lease: string): Promise<{ until: number }>;
  /** UX2-R55: the caller's own lease and its token die now; an unknown lease answers the same (nothing leaks). */
  close(caller: Caller, lease: string): Promise<void>;
  artifact(
    caller: Caller,
    input: { sessionId: string; entryId: string; fenceIndex: number },
  ): Promise<{ url: string; until: number }>;
}

export interface PreviewsServiceDeps {
  /** Absent without a VM stack: nothing runs, so the list is empty and the rest has no box. */
  readonly registry: Pick<PreviewRegistry, "start" | "stop" | "restart" | "list" | "refresh" | "logs"> | null;
  readonly tokens: Pick<PreviewTokens, "mintService" | "renew" | "close" | "mintArtifact">;
  /** The preview origin once the listener is bound; null when it could not bind (previews are off, spec §9b). */
  readonly origin: string | null;
  /** Who owns a box, from the daemon's records. */
  ownerOf(box: BoxRef): string | null;
  /** The runtime's phase of the box: tells a stopped box from a name the box does not hold. */
  phase(box: BoxRef): string;
  /** The egress list the proxy judges that box with now (UX2-R71); null when the box is unknown. */
  hostsOf(box: BoxRef): readonly string[] | null;
  /** The host names and addresses of the host itself and of pap's origins: never admitted into a page's CSP. */
  ownHosts(): readonly string[];
  /** `project.config` through the project box's guest, read fresh. */
  projectConfig(projectId: string): Promise<{ preview: PreviewDecl | null; previewInvalid: boolean }>;
  readonly logger: Pick<Logger, "debug">;
  /** The assistant text of a transcript entry of a session the caller owns (`not_found` otherwise); null when there is none. */
  entryText(sessionId: string, entryId: string, caller: Caller): Promise<string | null>;
}

/** UX2-R36: the service the project's own declaration starts. */
const PROJECT_SERVICE = "project";

export function createPreviewsService(deps: PreviewsServiceDeps): PreviewsService {
  const { registry, tokens } = deps;
  const viewOf = (box: BoxRef, service: ServiceView): PreviewView => ({ ...service, box });

  /** UX2-R32: the box kind's operate permission. */
  function permit(caller: Caller, box: BoxRef): void {
    if (!caller.permissions.has(box.kind === "agent" ? "agents:operate" : "sessions:operate"))
      throw new PapError("forbidden");
  }
  /** The box's owner: another owner's box is not_found, an unknown one too (existence does not leak). */
  function own(caller: Caller, box: BoxRef): void {
    const owner = deps.ownerOf(box);
    if (owner === null || owner !== caller.userId) throw new PapError("not_found");
  }
  /** Permission, a VM stack to ask (PF-10: without one nothing runs, `box_stopped`), then ownership. */
  function guard(caller: Caller, box: BoxRef): NonNullable<PreviewsServiceDeps["registry"]> {
    permit(caller, box);
    if (registry === null) throw new PapError("box_stopped");
    own(caller, box);
    return registry;
  }
  /** The calls that name no box (a lease, a transcript entry) need the project kind's permission, the pane's own. */
  const operate = (caller: Caller): void => {
    if (!caller.permissions.has("sessions:operate")) throw new PapError("forbidden");
  };
  const heldBy = (box: BoxRef, name: string): ServiceView | undefined =>
    registry?.list(box).find((service) => service.name === name);
  /** A name the box does not hold: not_found on a running box, box_stopped on one that is not. */
  const missing = (box: BoxRef): PapError =>
    new PapError(deps.phase(box) === "running" ? "not_found" : "box_stopped");

  return {
    async list(caller, box) {
      permit(caller, box);
      if (registry === null) return { services: [] };
      own(caller, box);
      // The guest's own list reconciles the registry (an eviction, an exit); a box that cannot answer shows what is held.
      const services = await registry.refresh(box).catch((error: unknown) => {
        deps.logger.debug("preview_list_refresh_failed", { box: boxKey(box), err: error });
        return registry.list(box);
      });
      return { services: services.map((service) => viewOf(box, service)) };
    },
    async stop(caller, box, name) {
      const held = guard(caller, box);
      if (heldBy(box, name) === undefined) throw missing(box);
      await held.stop(box, name);
    },
    async restart(caller, box, name) {
      const held = guard(caller, box);
      return { service: viewOf(box, await held.restart(box, name)) };
    },
    async startProject(caller, input) {
      const box: BoxRef = { kind: "project", id: input.projectId };
      const held = guard(caller, box);
      const declared = await deps.projectConfig(input.projectId);
      if (declared.preview === null) throw new PapError("bad_request");
      // The page showed this command and port (UX2-R58, R80): the file may have changed since, and the button runs what it showed.
      if (declared.preview.command !== input.command || declared.preview.port !== input.port)
        throw new PapError("conflict");
      const started = await held.start(box, caller.userId, {
        name: PROJECT_SERVICE,
        command: declared.preview.command,
        port: declared.preview.port,
        network: true,
      });
      return { service: viewOf(box, started) };
    },
    async logs(caller, box, name) {
      const held = guard(caller, box);
      return { lines: await held.logs(box, name) };
    },
    async open(caller, box, name) {
      guard(caller, box);
      const service = heldBy(box, name);
      if (service === undefined) throw missing(box);
      // A held service that is not running is gone for the pane (`previews.gone`); `unavailable` is the listener being down.
      if (service.state !== "running") throw new PapError("not_found");
      if (deps.origin === null) throw new PapError("unavailable");
      // UX2-R71: the page's hosts are the daemon's records at this moment, frozen in the grant; a service without network has none.
      const sources = service.network ? hostSources(deps.hostsOf(box) ?? [], deps.ownHosts()) : [];
      const minted = tokens.mintService({
        ownerId: caller.userId,
        box,
        serviceId: service.id,
        port: service.port,
        sources,
      });
      return {
        url: `${deps.origin}/p/${minted.token}/`,
        lease: minted.lease,
        leaseMs: PREVIEW_TOKEN_LIMITS.leaseMs,
      };
    },
    async renew(caller, lease) {
      operate(caller);
      const until = tokens.renew(caller.userId, lease);
      if (until === null) throw new PapError("not_found");
      return { until };
    },
    async close(caller, lease) {
      operate(caller);
      tokens.close(caller.userId, lease);
    },
    async artifact(caller, input) {
      operate(caller);
      if (deps.origin === null) throw new PapError("unavailable");
      // The client names an entry and a fence; the HTML is the daemon's own reading of the owner's transcript (UX2-R33).
      const text = await deps.entryText(input.sessionId, input.entryId, caller);
      const html = text === null ? null : htmlFenceBody(text, input.fenceIndex);
      if (html === null) throw new PapError("not_found");
      const minted = tokens.mintArtifact({
        ownerId: caller.userId,
        sessionId: input.sessionId,
        entryId: input.entryId,
        fenceIndex: input.fenceIndex,
        html,
      });
      return { url: `${deps.origin}/a/${minted.token}/`, until: minted.until };
    },
  };
}
