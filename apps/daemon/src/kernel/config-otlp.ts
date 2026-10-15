/** The header values are behind a function, so a logged or serialised config never holds them (M10R98). */
export interface OtlpConfig {
  /** Without a trailing slash; `https://`, or `http://` to a loopback host. */
  readonly endpoint: string;
  readonly serviceName: string;
  headers(): Readonly<Record<string, string>>;
}

const OTLP_LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const OTLP_HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const OTLP_HEADER_VALUE = /^[\x20-\x7e]{1,512}$/;
const OTLP_SERVICE_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const OTLP_MAX_HEADERS = 8;

// Unset or empty: no exporter. Every message is fixed text; the endpoint and the header values are never echoed.
export function parseOtlp(env: NodeJS.ProcessEnv, refuse: (message: string) => Error): OtlpConfig | null {
  const raw = env.PAP_OTLP_ENDPOINT;
  if (raw === undefined || raw === "") return null;
  const serviceName = env.PAP_OTLP_SERVICE_NAME ?? "pap";
  if (!OTLP_SERVICE_NAME.test(serviceName))
    throw refuse("PAP_OTLP_SERVICE_NAME must be 1 to 64 characters of A-Z a-z 0-9 . _ -");
  const headers = parseOtlpHeaders(env.PAP_OTLP_HEADERS, refuse);
  return { endpoint: parseOtlpEndpoint(raw, refuse), serviceName, headers: () => ({ ...headers }) };
}

function parseOtlpEndpoint(raw: string, refuse: (message: string) => Error): string {
  const refusal = (): Error =>
    refuse("PAP_OTLP_ENDPOINT must be an https:// URL, or an http:// URL to localhost, 127.0.0.1 or [::1]");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw refusal();
  }
  const plainLoopback = url.protocol === "http:" && OTLP_LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !plainLoopback) throw refusal();
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") throw refusal();
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

function parseOtlpHeaders(
  raw: string | undefined,
  refuse: (message: string) => Error,
): Record<string, string> {
  const refusal = (): Error =>
    refuse(
      `PAP_OTLP_HEADERS must be at most ${OTLP_MAX_HEADERS} name=value pairs separated by commas (name: A-Z a-z 0-9 -, value: 1 to 512 printable ASCII)`,
    );
  if (raw === undefined || raw === "") return {};
  const pairs = raw.split(",");
  if (pairs.length > OTLP_MAX_HEADERS) throw refusal();
  const headers: Record<string, string> = {};
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    const name = at < 0 ? "" : pair.slice(0, at);
    const value = at < 0 ? "" : pair.slice(at + 1);
    if (!OTLP_HEADER_NAME.test(name) || !OTLP_HEADER_VALUE.test(value)) throw refusal();
    headers[name] = value;
  }
  return headers;
}
