/** The preview listener's settings (UX2-R7): the port of the untrusted origin and an optional origin override. */
export interface PreviewEnv {
  readonly previewPort: number;
  /** `PAP_PREVIEW_ORIGIN`; null: the default origin, computed once the listener is bound (`previewOriginOf`). */
  readonly previewOrigin: string | null;
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Messages are fixed text: no flag or environment value is echoed. `port` is the main port (0: tests, the preview binds 0 too). */
export function parsePreview(
  input: {
    flag: string | undefined;
    env: NodeJS.ProcessEnv;
    port: number;
    insecureHttp: boolean;
    /** The public origin and every allowed origin of the app: the preview origin is never one of them. */
    appOrigins: ReadonlySet<string>;
  },
  refuse: (message: string) => Error,
): PreviewEnv {
  return {
    previewPort: parsePort(input.flag ?? input.env.PAP_PREVIEW_PORT, input.port, refuse),
    previewOrigin: parseOrigin(input.env.PAP_PREVIEW_ORIGIN, input.insecureHttp, input.appOrigins, refuse),
  };
}

function parsePort(raw: string | undefined, mainPort: number, refuse: (message: string) => Error): number {
  if (mainPort === 0) return 0;
  if (raw === undefined || raw === "") {
    if (mainPort >= 65_535)
      throw refuse(`the app is on port ${mainPort}: set --preview-port or PAP_PREVIEW_PORT`);
    return mainPort + 1;
  }
  const port = /^\d{1,5}$/.test(raw) ? Number(raw) : 0;
  if (port < 1 || port > 65_535) throw refuse("--preview-port must be an integer from 1 to 65535");
  if (port === mainPort) throw refuse("the preview port must differ from the port of the app");
  return port;
}

function parseOrigin(
  raw: string | undefined,
  insecureHttp: boolean,
  appOrigins: ReadonlySet<string>,
  refuse: (message: string) => Error,
): string | null {
  if (raw === undefined || raw === "") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw refuse("PAP_PREVIEW_ORIGIN must be an origin such as https://preview.example.net");
  }
  // url.origin drops any user:password@ part, so credentials never reach Config.
  if (url.origin === "null" || (url.protocol !== "https:" && url.protocol !== "http:"))
    throw refuse("PAP_PREVIEW_ORIGIN must be an origin such as https://preview.example.net");
  if (url.protocol === "http:" && !insecureHttp && !LOOPBACK_HOSTS.has(url.hostname))
    throw refuse(
      "PAP_PREVIEW_ORIGIN must be an https:// origin (http:// only for localhost or with --insecure-http)",
    );
  // The app's own origin would give untrusted pages pap's origin (and its cookie): previews would break and frame pap itself.
  if (appOrigins.has(url.origin)) throw refuse("PAP_PREVIEW_ORIGIN must differ from the origins of the app");
  return url.origin;
}

/** The origin the browser reaches the preview listener at: the override, else the public origin with the bound port. */
export function previewOriginOf(publicOrigin: string, boundPort: number, override: string | null): string {
  if (override !== null) return override;
  const url = new URL(publicOrigin);
  url.port = String(boundPort);
  return url.origin;
}
