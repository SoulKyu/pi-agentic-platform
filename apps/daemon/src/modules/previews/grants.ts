import { type BoxRef, boxKey, parseBoxKey } from "@pap/contracts";
import type { BoxTunnels } from "../../kernel/boxes.ts";
import type { PreviewListenerDeps } from "../../kernel/http/preview/listener.ts";
import { tunnelSocket } from "../../kernel/http/preview/tunnel-socket.ts";
import type { PreviewRegistry } from "./registry.ts";
import type { PreviewTokens } from "./tokens.ts";

export interface PreviewGrantsDeps {
  readonly tokens: Pick<PreviewTokens, "resolve">;
  /** Absent without a VM stack: no service grant, artifacts still served. */
  readonly registry: Pick<PreviewRegistry, "byId"> | null;
  readonly tunnels: BoxTunnels | null;
  /** Relayed traffic keeps the box awake (the listener throttles the calls to one per 10 s per box). */
  readonly touch?: (box: BoxRef) => void;
}

/**
 * What the untrusted listener asks of a token (UX2-R34, R35). A service token is a grant only while the registry holds its
 * service running in the box the token was minted for, so a stale token of an exited or restarted service is a 404; its
 * tunnel is the box's, opened per request. The port is the registry's, never the token's word alone.
 */
export function createPreviewGrants(deps: PreviewGrantsDeps): {
  grantOf: PreviewListenerDeps["grantOf"];
  onTraffic(boxText: string): void;
} {
  return {
    grantOf(kind, token) {
      const grant = deps.tokens.resolve(kind, token);
      if (grant === null) return null;
      if (grant.kind === "artifact") return { kind: "artifact", html: grant.html };
      const service = deps.registry?.byId(grant.serviceId) ?? null;
      const tunnels = deps.tunnels;
      if (
        service === null ||
        tunnels === null ||
        service.view.state !== "running" ||
        boxKey(service.box) !== boxKey(grant.box) ||
        service.ownerId !== grant.ownerId
      )
        return null;
      const { box } = service;
      return {
        kind: "service",
        box: boxKey(box),
        port: service.view.port,
        sources: grant.sources,
        // The channel is wrapped in the turn it arrives: frames received before a listener is set would pile up unbounded (T7).
        open: () => tunnels.open(box, grant.serviceId).then(tunnelSocket),
      };
    },
    onTraffic(boxText) {
      const box = parseBoxKey(boxText);
      if (box !== null) deps.touch?.(box);
    },
  };
}
