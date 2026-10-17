import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";

export interface HealthTarget {
  readonly host: string | null;
  readonly port: number;
  readonly tls: boolean;
}

/** The address the unit's own daemon answers on: `--host` when given (a wildcard means loopback), else 127.0.0.1. */
export function probeHost(host: string | null): string {
  if (host === null || host === "0.0.0.0" || host === "") return "127.0.0.1";
  if (host === "::" || host === "[::]") return "::1";
  return host.replace(/^\[|\]$/g, "");
}

/**
 * `GET /healthz` on the address and scheme the unit starts: 200 and exactly `{"status":"ok"}`, at most 1 KiB, `timeoutMs`
 * in total (a timer on the whole request: a server that sends a byte now and then never trips an idle timeout).
 * The certificate is not verified: this talks to the machine's own address, and a certificate for the public name would
 * otherwise fail every good update on an HTTPS setup (M6bR11c).
 */
export function probeHealth(target: HealthTarget, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const options = {
      host: probeHost(target.host),
      port: target.port,
      path: "/healthz",
      method: "GET",
    };
    const deadline = setTimeout(() => {
      req.destroy();
      done(false);
    }, timeoutMs);
    const done = (ok: boolean): void => {
      clearTimeout(deadline);
      resolve(ok);
    };
    const req = target.tls
      ? httpsRequest({ ...options, rejectUnauthorized: false }, (res) => answer(res))
      : httpRequest(options, (res) => answer(res));
    function answer(res: IncomingMessage): void {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1024) {
          res.destroy();
          done(false);
        } else chunks.push(chunk);
      });
      res.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { status?: unknown } | null;
          done(res.statusCode === 200 && body?.status === "ok");
        } catch {
          done(false);
        }
      });
      res.on("error", () => done(false));
    }
    req.on("error", () => done(false));
    req.end();
  });
}
