import { spawn } from "node:child_process";
import { basename, dirname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { FakeGithubCall } from "./fake-github.ts";
import type { Json } from "./fake-github-util.ts";

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/;
const BODY_MAX = 64 * 1024 * 1024;

export interface FakeGitContext {
  readonly repos: ReadonlyMap<string, { readonly bare: string }>;
  readonly minted: ReadonlyArray<{ token: string; permissions: Json; repositories: string[] }>;
  readonly calls: FakeGithubCall[];
}

const deny = (response: ServerResponse, status: number, headers: Record<string, string> = {}): true => {
  response.writeHead(status, { "content-type": "text/plain", ...headers }).end(`${status}\n`);
  return true;
};

/** The password of a Basic `Authorization` header (the box token the credential helper answered with). */
const passwordOf = (header: string | undefined): string | null => {
  if (!header?.startsWith("Basic ")) return null;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  return decoded.slice(decoded.indexOf(":") + 1) || null;
};

/**
 * Git over smart HTTP for the fake's repositories (`/<owner>/<name>.git/...`, through `git http-backend`), so a box can clone
 * and push for real. It answers 401 until the request carries a token the fake minted, and 403 to a token that does not name
 * this repository, or a push by one without `contents: write`. Returns false for a path that is not a repository's.
 */
export function serveGit(request: IncomingMessage, response: ServerResponse, ctx: FakeGitContext): boolean {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const found = GIT_PATH.exec(url.pathname);
  if (!found) return false;
  const [, owner, name, rest] = found as unknown as [string, string, string, string];
  const fullName = `${owner}/${name}`;
  const repo = ctx.repos.get(fullName);
  if (!repo) return false;
  const method = request.method ?? "GET";
  const pushes = rest === "git-receive-pack" || url.searchParams.get("service") === "git-receive-pack";
  const authorization = request.headers.authorization ?? null;
  ctx.calls.push({
    method,
    path: url.pathname,
    route: `GIT ${pushes ? "push" : "fetch"}`,
    query: url.search.slice(1),
    body: {},
    authorization,
    error: null,
  });
  const token = passwordOf(authorization ?? undefined);
  if (token === null) return deny(response, 401, { "www-authenticate": 'Basic realm="fake github"' });
  const grant = ctx.minted.find((entry) => entry.token === token);
  const reaches = grant?.repositories.some(
    (repository) => repository.toLowerCase() === fullName.toLowerCase(),
  );
  const writes = (grant?.permissions as Record<string, string> | undefined)?.contents === "write";
  if (!grant || !reaches || (pushes && !writes)) return deny(response, 403);

  const chunks: Buffer[] = [];
  let size = 0;
  request.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size <= BODY_MAX) chunks.push(chunk);
  });
  request.on("end", () => {
    const child = spawn("git", ["http-backend"], {
      env: {
        PATH: process.env.PATH ?? "",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_PROJECT_ROOT: dirname(repo.bare),
        GIT_HTTP_EXPORT_ALL: "1",
        REQUEST_METHOD: method,
        PATH_INFO: `/${basename(repo.bare)}/${rest}`,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: request.headers["content-type"] ?? "",
        CONTENT_LENGTH: String(Math.min(size, BODY_MAX)),
        ...(request.headers["content-encoding"]
          ? { HTTP_CONTENT_ENCODING: request.headers["content-encoding"] }
          : {}),
        REMOTE_USER: "x-access-token",
        REMOTE_ADDR: "127.0.0.1",
      },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const out: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stdin.on("error", () => undefined);
    child.stdin.end(Buffer.concat(chunks));
    child.once("error", () => deny(response, 500));
    child.once("close", () => {
      const cgi = Buffer.concat(out);
      const split = cgi.indexOf("\r\n\r\n");
      if (split < 0) return void deny(response, 500);
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of cgi.subarray(0, split).toString("utf8").split("\r\n")) {
        const colon = line.indexOf(":");
        if (colon < 0) continue;
        const key = line.slice(0, colon).toLowerCase();
        const value = line.slice(colon + 1).trim();
        if (key === "status") status = Number.parseInt(value, 10) || 200;
        else headers[key] = value;
      }
      response.writeHead(status, headers).end(cgi.subarray(split + 4));
    });
  });
  return true;
}
