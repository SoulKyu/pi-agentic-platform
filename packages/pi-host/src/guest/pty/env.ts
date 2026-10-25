import type { VmLayout } from "@pap/contracts/pi-host";
import { proxyEnv } from "../../vm-shell/proxy-env.ts";

/** The `gh` wrapper's folder (the base image copies the bundle here); it comes first in a terminal's PATH. */
export const PTY_BIN_DIR = "/opt/pap/pi-host/bin";
const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/**
 * A box terminal's environment, built from nothing: the gateway token and every other guest variable stay out. The proxy
 * variables are there when the guest has an egress proxy.
 */
export function ptyEnv(
  guestEnv: NodeJS.ProcessEnv,
  layout: Pick<VmLayout, "home">,
  gatewayHost: string | undefined,
): Record<string, string> {
  const proxy = guestEnv.PAP_GUEST_PROXY;
  return {
    PATH: `${PTY_BIN_DIR}:${guestEnv.PATH || DEFAULT_PATH}`,
    HOME: layout.home,
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
    ...(proxy ? proxyEnv(`http://${proxy}`, gatewayHost) : {}),
  };
}
