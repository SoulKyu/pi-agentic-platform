// The stand-in for an agent's service (UX2-R86, red team I2): a tiny server on the origin the daemon was told is its preview
// origin (`PAP_PREVIEW_ORIGIN`), so the app's `frame-src` admits it and a journey can frame it in pap's real page.
//   /headers  the headers of the daemon's preview listener's bare 404, copied byte for byte (UX2-R53): the no-network
//             service CSP naming this origin. What a real service's page runs under.
//   /bare     only the CSP `sandbox` directive and `frame-ancestors` (the layers under the fetch directives, as a browser
//             that ignored the fetch directives would see the page).
// Both pages run the same probes against pap with credentials and write each outcome into `document.body.dataset`.
import { createServer, request, type Server } from "node:http";
import type { Socket } from "node:net";

/** The headers every answer of the untrusted origin carries (`untrustedHeaders`, kernel/http/preview/headers.ts). */
export const SECURITY_HEADERS = [
  "content-security-policy",
  "referrer-policy",
  "cache-control",
  "x-content-type-options",
  "x-dns-prefetch-control",
  "access-control-allow-origin",
] as const;

export interface StandInConfig {
  /** The listener's bare answer is read here: `http://127.0.0.1:<previewPort>`. */
  readonly listener: string;
  /** pap's origin as the browser names it. */
  readonly app: string;
  /** The absolute path of a file of pap's project that the probes try to read through `/files/raw`. */
  readonly canary: string;
  /** The body of the probes' `POST /upload`: the journey looks for it on disk afterwards. */
  readonly marker: string;
  /** An address no test may reach; the CSP page must never get a request out to it. */
  readonly offLimits: string;
}

export interface StandIn {
  readonly origin: string;
  readonly headers: Readonly<Record<string, string>>;
  close(): Promise<void>;
}

/** The listener's bare 404: `GET /` answers 404 with the security headers and nothing else of interest. */
function listenerHeaders(listener: string): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const req = request(listener, { method: "GET", agent: false }, (res) => {
      res.resume();
      if (res.statusCode !== 404)
        return reject(new Error(`the preview listener answered ${res.statusCode}, expected 404`));
      const copied: Record<string, string> = {};
      for (const name of SECURITY_HEADERS) {
        const value = res.headers[name];
        if (typeof value !== "string") return reject(new Error(`the preview listener's 404 has no ${name}`));
        copied[name] = value;
      }
      resolve(copied);
    });
    req.on("error", reject);
    req.end();
  });
}

const directive = (csp: string, name: string): string => {
  const hit = csp
    .split(";")
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));
  if (hit === undefined) throw new Error(`the preview CSP has no ${name} directive: ${csp}`);
  return hit;
};

/** The `/bare` CSP: the listener's own `sandbox` and `frame-ancestors` directives, no fetch directive. */
export const bareCsp = (listenerCsp: string): string =>
  `${directive(listenerCsp, "sandbox")}; ${directive(listenerCsp, "frame-ancestors")}`;

/** The probes: three routes of pap and one off-limits address, each outcome in `document.body.dataset`. */
function page(config: StandInConfig, withOffLimits: boolean): string {
  const probes = {
    read: `${config.app}/files/raw?path=${encodeURIComponent(config.canary)}`,
    post: `${config.app}/upload?sessionId=probe&name=probe.txt`,
    socket: `${config.app.replace(/^http/, "ws")}/ws?proto=2`,
    marker: config.marker,
    offLimits: withOffLimits ? config.offLimits : null,
  };
  const json = JSON.stringify(probes).replaceAll("<", "\\u003c");
  return `<!doctype html><meta charset="utf-8"><title>stand-in</title><p>stand-in</p>
<script>
const probes = ${json};
const out = document.body.dataset;
const seen = [];
document.addEventListener("securitypolicyviolation", (event) => {
  seen.push(event.effectiveDirective + " " + event.blockedURI);
  out.csp = JSON.stringify(seen);
});
const settle = (name, work) => work.then((value) => { out[name] = value; }, () => { out[name] = "blocked"; });
const text = async (response) => { out.readText = await response.text(); return "answered"; };
const socket = () => new Promise((resolve) => {
  let ws;
  try { ws = new WebSocket(probes.socket); } catch { return resolve("blocked"); }
  ws.onopen = () => resolve("opened");
  ws.onerror = () => resolve("blocked");
  ws.onclose = () => resolve("blocked");
  setTimeout(() => resolve("pending"), 8000);
});
const all = [
  settle("read", fetch(probes.read, { credentials: "include" }).then(text)),
  settle("readNoCors", fetch(probes.read, { credentials: "include", mode: "no-cors" }).then((r) => r.type)),
  settle("post", fetch(probes.post, { method: "POST", credentials: "include", mode: "no-cors", body: probes.marker }).then((r) => r.type)),
  settle("socket", socket()),
];
if (probes.offLimits !== null) all.push(settle("offLimits", fetch(probes.offLimits, { mode: "no-cors" }).then((r) => r.type)));
Promise.all(all).then(() => { out.done = "1"; });
</script>`;
}

/** Listens on 127.0.0.1:`port`; the browser names it through `origin` (the daemon's `PAP_PREVIEW_ORIGIN`). */
export async function startStandIn(port: number, origin: string, config: StandInConfig): Promise<StandIn> {
  const headers = await listenerHeaders(config.listener);
  const bare = bareCsp(headers["content-security-policy"] ?? "");
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://stand-in.invalid").pathname;
    if (path === "/headers") {
      res.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8" });
      res.end(page(config, true));
    } else if (path === "/bare") {
      res.writeHead(200, { "content-security-policy": bare, "content-type": "text/html; charset=utf-8" });
      res.end(page(config, false));
    } else {
      res.writeHead(404, { ...headers, "content-length": "0" }).end();
    }
  });
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", fail);
      done();
    });
  });
  const open = new Set<Socket>();
  server.on("connection", (socket) => {
    open.add(socket);
    socket.once("close", () => open.delete(socket));
  });
  return {
    origin,
    headers,
    close: () =>
      new Promise<void>((done) => {
        for (const socket of open) socket.destroy();
        server.close(() => done());
      }),
  };
}
