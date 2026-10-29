import { openableSetupUrl } from "./daemon-setup-url.ts";
import type { DaemonDeps } from "./daemon-types.ts";
import type { Config } from "./kernel/config.ts";
import type { Logger } from "./kernel/logger.ts";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

/** What the daemon says once it listens: the one-time setup URL (returned, openable) and the two transport warnings. */
export function announceStart(
  config: Config,
  logger: Logger,
  deps: Pick<DaemonDeps, "announceSetupUrl">,
  rawSetupUrl: string | null,
): string | null {
  const setupUrl = openableSetupUrl(config, rawSetupUrl);
  if (setupUrl) {
    const fields = { url: setupUrl, hint: "Open this URL once to create the owner account." };
    if (deps.announceSetupUrl) deps.announceSetupUrl(fields);
    else logger.info("setup_url", fields);
  }
  if (!LOOPBACK.has(config.host) && !config.tls) {
    logger.warn("plain_http_on_network", {
      hint: "Passkeys, secure cookies and Web Push need HTTPS: use Tailscale serve, a reverse proxy or --tls-cert/--tls-key. Browsers on other machines are only accepted under the address in PAP_PUBLIC_ORIGIN; set it to the one they type.",
    });
  }
  if (config.insecureHttp) {
    logger.warn("insecure_http", {
      hint: "--insecure-http: session cookies travel without Secure over plain HTTP, readable by anyone on the network, and so is a terminal's shell (sniffing the cookie opens one). For testing on a trusted LAN only.",
    });
  }
  return setupUrl;
}
