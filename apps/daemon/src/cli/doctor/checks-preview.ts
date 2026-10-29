import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { listenFacts, probeHostOf } from "./listen-facts.ts";
import type { Check } from "./types.ts";

export interface PreviewAnswer {
  readonly status: number;
  /** The `Content-Security-Policy` header, or null. */
  readonly csp: string | null;
}
export type PreviewProbe = (target: {
  host: string;
  port: number;
  tls: boolean;
}) => Promise<PreviewAnswer | null>;

const PROBE_DEADLINE_MS = 2000;

/** `GET /` on the preview port: a status and one header, nothing sent. With TLS the certificate is not verified. */
export const probePreview: PreviewProbe = ({ host, port, tls }) =>
  new Promise((resolve) => {
    const request = tls ? httpsRequest : httpRequest;
    const req = request(
      {
        host,
        port,
        path: "/",
        method: "GET",
        timeout: PROBE_DEADLINE_MS,
        ...(tls ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const csp = res.headers["content-security-policy"];
        resolve({ status: res.statusCode ?? 0, csp: typeof csp === "string" ? csp : null });
        res.destroy();
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
    req.end();
  });

const FIX =
  "another program holds the preview port: see `preview_listener_unavailable` in the log, or set `PAP_PREVIEW_PORT`";

export function makePreviewCheck(probe: PreviewProbe): Check {
  return {
    id: "preview.listener",
    title: "Preview listener",
    async run(ctx) {
      if (!ctx.lockHeld) return { status: "skip", detail: "pap is not running" };
      const facts = listenFacts(ctx.unit, ctx.env);
      const port = facts.previewPort;
      const answer = await probe({ host: probeHostOf(ctx.unit), port, tls: facts.tls });
      if (answer === null)
        return { status: "fail", detail: `nothing answers on preview port ${port}`, fix: FIX };
      if (answer.status === 404 && answer.csp?.startsWith("sandbox ") === true)
        return { status: "ok", detail: `the preview listener answers on port ${port}` };
      return {
        status: "warn",
        detail: `port ${port} answers, but it does not look like pap's preview listener`,
        fix: FIX,
      };
    },
  };
}
