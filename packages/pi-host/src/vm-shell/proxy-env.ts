import { AGENT_NET } from "@pap/contracts/pi-host";

/** The variables that point a tool at pap's egress proxy (spec §3); the worker and the networked shell carry exactly these. */
export const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_USE_ENV_PROXY",
] as const;

/** Names that never go through the proxy: the gateway's LLM and Claude names, the bridge, loopback (and the gateway host when it differs). */
const NO_PROXY_BASE = ["llm.internal", "claude.internal", AGENT_NET.host, "localhost", "127.0.0.1"];

/** The proxy variables for one proxy URL; `gatewayHost` joins the no-proxy list when it is not already there. */
export function proxyEnv(
  proxy: string,
  gatewayHost?: string,
): Record<(typeof PROXY_ENV_KEYS)[number], string> {
  const noProxy = [...new Set([...NO_PROXY_BASE, ...(gatewayHost ? [gatewayHost] : [])])].join(",");
  return {
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    NODE_USE_ENV_PROXY: "1",
  };
}

/** The proxy variables a process environment holds (the networked shell's copy of the worker's). */
export function pickProxyEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const key of PROXY_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined) picked[key] = value;
  }
  return picked;
}
