import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BoxRef } from "@pap/contracts";
import type { PreviewRegistry } from "../modules/previews/index.ts";
import type { TestDaemon } from "./harness.ts";
import { httpRequest, type HttpReply } from "./http-client.ts";

// Shared by the previews' integration files: a service that answers with what it saw, and the preview listener reached the way a
// browser's frame reaches it (the capability path on the preview port). Nothing here leaves the host.

/** A `node` server that answers every request with what it saw, sets a cookie, and answers `/ws` upgrades with nothing. */
export const serviceCommand = (port: number): string =>
  `node -e "require('http').createServer((q,r)=>{r.setHeader('set-cookie','sid=1');r.setHeader('content-type','application/json');` +
  `r.end(JSON.stringify({cookie:q.headers.cookie??null,url:q.url,prefix:q.headers['x-forwarded-prefix']??null}))` +
  `}).listen(${port},'127.0.0.1')"`;

/** `.pi/project.yaml` declaring a preview (JSON is YAML). */
export const declarationOf = (command: string, port: number): string =>
  JSON.stringify({ preview: { command, port } });

/** The preview port the app announces in its `frame-src` (the daemon binds port 0 in tests). */
export async function previewPortOf(t: TestDaemon): Promise<number> {
  const csp = String((await httpRequest(`${t.base}/healthz`)).headers["content-security-policy"]);
  const match = /frame-src http:\/\/localhost:(\d+)/.exec(csp);
  if (match?.[1] === undefined) throw new Error(`no frame-src in the app's CSP: ${csp}`);
  return Number(match[1]);
}

/** A GET of the capability URL's path (and `path` below it) on the preview listener at 127.0.0.1. */
export const through = (
  port: number,
  capabilityUrl: string,
  path = "",
  headers: Record<string, string> = {},
): Promise<HttpReply> =>
  httpRequest(`http://127.0.0.1:${port}${new URL(capabilityUrl).pathname}${path}`, { headers });

export const registryOf = (t: TestDaemon): PreviewRegistry => {
  const registry = t.daemon.inspect.previews() as PreviewRegistry | null;
  if (registry === null) throw new Error("the previews registry is not bound");
  return registry;
};

/**
 * Writes the project's `.pi/project.yaml` with a preview and returns the command and port the page would have shown. On the
 * process backend a box's folder is a real folder, and the file goes in directly: through `files.write` it would need a step-up.
 */
export function declare(project: { root: string }, port: number): { command: string; port: number } {
  const command = serviceCommand(port);
  mkdirSync(join(project.root, ".pi"), { recursive: true });
  writeFileSync(join(project.root, ".pi", "project.yaml"), declarationOf(command, port));
  return { command, port };
}

export type ServiceReply = { cookie: string | null; url: string; prefix: string | null };
export const bodyOf = (reply: HttpReply): ServiceReply => JSON.parse(reply.body) as ServiceReply;
export const projectBox = (projectId: string): BoxRef => ({ kind: "project", id: projectId });
