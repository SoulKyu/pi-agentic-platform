import { type Config, VITE_DEV_ORIGIN } from "./kernel/config.ts";

// In `--dev` the browser talks to Vite, which proxies to the daemon: that is the address to open (R31).
export function openableSetupUrl(config: Config, setupUrl: string | null): string | null {
  if (!setupUrl || !config.dev) return setupUrl;
  const url = new URL(setupUrl);
  const vite = new URL(VITE_DEV_ORIGIN);
  url.protocol = vite.protocol;
  url.host = vite.host;
  return url.href;
}
