/*
 * The one place that classifies origin, TLS and `--insecure-http` for push and install (M12R38, cross-plan agreement 2).
 * Pure and free of I/O and of any `modules/` import: `pap doctor` imports this file without the push module.
 * `keys_unreadable` is not a fact of the origin: it comes from the key file (`push.config.reason`, doctor's `push` check).
 */

export type PushReadiness =
  | { status: "ready"; origin: string }
  | { status: "localhost_only"; origin: string; hint: string }
  | { status: "insecure_http"; origin: string; hint: string }
  | { status: "origin_mismatch"; origin: string; hint: string };

export interface PushReadinessFacts {
  readonly publicOrigin: string;
  readonly tls: boolean;
  readonly insecureHttp: boolean;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The routes, in the agreed order (decision 75 first). pap reads no X-Forwarded-* headers. At most 200 characters. */
const HTTPS_ROUTES =
  "Use an HTTPS origin: ngrok, Tailscale serve, or a reverse proxy, each through PAP_PUBLIC_ORIGIN; or --tls-cert/--tls-key.";

export function pushReadiness(facts: PushReadinessFacts): PushReadiness {
  let url: URL;
  try {
    url = new URL(facts.publicOrigin);
  } catch {
    return {
      status: "origin_mismatch",
      origin: facts.publicOrigin.slice(0, 200),
      hint: "PAP_PUBLIC_ORIGIN is not a valid URL.",
    };
  }
  const origin = url.origin;
  if (url.protocol === "https:") return { status: "ready", origin };
  if (url.protocol !== "http:")
    return { status: "origin_mismatch", origin, hint: "PAP_PUBLIC_ORIGIN must be an http or https URL." };
  if (facts.tls)
    return {
      status: "origin_mismatch",
      origin,
      hint: "pap serves TLS but PAP_PUBLIC_ORIGIN says http: set it to the https origin.",
    };
  if (LOCAL_HOSTS.has(url.hostname))
    return {
      status: "localhost_only",
      origin,
      hint: "Notifications work on this machine only. For other devices: " + HTTPS_ROUTES,
    };
  return { status: "insecure_http", origin, hint: HTTPS_ROUTES };
}
