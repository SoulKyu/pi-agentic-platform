import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bearerOf, createFakeAccess, type FakeGithubAccess } from "./fake-github-access.ts";
import { apiRoutes } from "./fake-github-api.ts";
import { serveGit } from "./fake-github-git.ts";
import { makeBare, match, readBody, type Json } from "./fake-github-util.ts";

export interface FakeGithubCall {
  readonly method: string;
  readonly path: string;
  /** The route pattern that answered (`GET /repos/:o/:r/pulls`), or null for an unknown path. */
  route: string | null;
  readonly query: string; // raw, `?` excluded
  readonly body: Json;
  readonly authorization: string | null;
  /** The class and message of an error the fake itself raised (answered 500, or 400 for a malformed path); never a secret. */
  error: string | null;
}

export interface FakeGithubResponse {
  readonly status: number;
  readonly body?: unknown;
  /** Extra response headers (`x-ratelimit-remaining: 0`). */
  readonly headers?: Record<string, string>;
}

export interface FakeGithubRepo {
  readonly fullName: string;
  readonly private: boolean;
  readonly defaultBranch: string;
  /** A local bare repository: what `clone_url` points at (`file://`). */
  readonly bare: string;
}

export interface FakeGithubState {
  /** Every request, in order. */
  readonly calls: FakeGithubCall[];
  /** The manifests posted to `/settings/apps/new`, as the JSON text the browser sent. */
  readonly manifests: string[];
  readonly login: string;
  readonly repos: Map<string, FakeGithubRepo>;
  /** What the App is allowed to grant; a token asked for more is `422`. */
  appPermissions: Record<string, string>;
  /** The ids and titles of the keys uploaded to `/user/ssh_signing_keys`, still present. */
  readonly signingKeys: Map<number, { title: string; key: string }>;
  /** The newest user token pair; older refresh tokens are spent. */
  readonly userTokens: { access: string; refresh: string; refreshes: number };
  /** The installation tokens minted, with what they were granted. */
  readonly minted: Array<{ token: string; permissions: Json; repositories: string[] }>;
  /** The installation tokens revoked with `DELETE /installation/token`. */
  readonly revoked: string[];
  /** Answers `route` (`GET /user`) with `response` for the next `times` calls (default: every call) instead of the built-in handler. */
  respond(route: string, response: FakeGithubResponse, times?: number): void;
  /** Same as `respond` with an error body: `fail("POST /user/ssh_signing_keys", 403)`. */
  fail(route: string, status: number, message?: string, times?: number): void;
  /** Data for the list endpoints, keyed by `owner/name` (check runs by `owner/name@ref`, job logs by `owner/name#jobId`). */
  readonly data: {
    pulls: Map<string, unknown[]>;
    issues: Map<string, unknown[]>;
    releases: Map<string, unknown[]>;
    checkRuns: Map<string, unknown[]>;
    jobLogs: Map<string, string>;
    /** `owner/name#jobId` -> Location: the log route answers 302 there, as GitHub does. */
    logLocations: Map<string, string>;
    blobs: Map<string, string>;
  };
  /** Who sees which repository through `GET /repos/:o/:r`, and with what permission. */
  readonly access: FakeGithubAccess;
  /** Creates `owner/name` with a local bare repository holding one commit on `main`. */
  addRepo(fullName: string, options?: { private?: boolean }): FakeGithubRepo;
  /** The calls to routes that start with `prefix`, in order. */
  callsTo(prefix: string): FakeGithubCall[];
}

export interface FakeGithub {
  readonly origin: string;
  readonly state: FakeGithubState;
  close(): Promise<void>;
}

/** A loopback GitHub for tests: the endpoints pap uses, a record of every call and a way to answer or fail each one. */
export async function startFakeGithub(): Promise<FakeGithub> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pap-fake-github-")));
  const login = "octo";
  const calls: FakeGithubCall[] = [];
  const overrides = new Map<string, { response: FakeGithubResponse; times: number }>();
  const usedCodes = new Set<string>();
  let counter = 1000;
  const next = (): number => ++counter;
  let origin = "";

  const state: FakeGithubState = {
    calls,
    manifests: [],
    login,
    repos: new Map(),
    appPermissions: {
      contents: "write",
      pull_requests: "write",
      issues: "read",
      checks: "read",
      actions: "read",
      metadata: "read",
      administration: "write",
    },
    signingKeys: new Map(),
    userTokens: { access: "", refresh: "", refreshes: 0 },
    minted: [],
    revoked: [],
    data: {
      pulls: new Map(),
      issues: new Map(),
      releases: new Map(),
      checkRuns: new Map(),
      jobLogs: new Map(),
      logLocations: new Map(),
      blobs: new Map(),
    },
    respond(route, response, times = Number.POSITIVE_INFINITY) {
      overrides.set(route, { response, times });
    },
    fail(route, status, message = "fake failure", times) {
      state.respond(route, { status, body: { message } }, times);
    },
    access: createFakeAccess(),
    addRepo(fullName, options = {}) {
      const bare = join(dir, `${fullName.replace("/", "__")}.git`);
      makeBare(bare, null);
      const repo = { fullName, private: options.private ?? false, defaultBranch: "main", bare };
      state.repos.set(fullName, repo);
      return repo;
    },
    callsTo: (prefix) => calls.filter((call) => call.route?.startsWith(prefix) ?? false),
  };

  const repoJson = (repo: FakeGithubRepo): Json => ({
    full_name: repo.fullName,
    name: repo.fullName.split("/")[1],
    private: repo.private,
    default_branch: repo.defaultBranch,
    clone_url: `file://${repo.bare}`,
    html_url: `${origin}/${repo.fullName}`,
  });
  const mintUserPair = (): Json => {
    state.userTokens.access = `ghu_${randomBytes(8).toString("hex")}`;
    state.userTokens.refresh = `ghr_${randomBytes(8).toString("hex")}`;
    return {
      access_token: state.userTokens.access,
      refresh_token: state.userTokens.refresh,
      expires_in: 28_800,
      refresh_token_expires_in: 15_811_200,
      token_type: "bearer",
    };
  };

  type Handler = (p: Record<string, string>, body: Json, request: IncomingMessage) => FakeGithubResponse;
  const ok = (body: unknown, status = 200): FakeGithubResponse => ({ status, body });
  const error = (status: number, message: string): FakeGithubResponse => ({ status, body: { message } });
  const routes: Array<[string, Handler]> = [
    [
      "POST /app-manifests/:code/conversions",
      (p) => {
        if (usedCodes.has(p.code ?? "")) return error(404, "Not Found");
        usedCodes.add(p.code ?? "");
        return ok(
          {
            id: 4242,
            slug: "pap-fake",
            name: "pap-fake",
            client_id: "Iv1.fake",
            client_secret: randomBytes(16).toString("hex"),
            webhook_secret: null,
            pem: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n",
            html_url: `${origin}/apps/pap-fake`,
            owner: { login },
          },
          201,
        );
      },
    ],
    [
      "POST /login/oauth/access_token",
      (_p, body) => {
        if (body.grant_type === "refresh_token") {
          if (body.refresh_token !== state.userTokens.refresh) return ok({ error: "bad_refresh_token" });
          state.userTokens.refreshes += 1;
          return ok(mintUserPair());
        }
        const code = String(body.code ?? "");
        if (!code || usedCodes.has(`oauth:${code}`)) return ok({ error: "bad_verification_code" });
        usedCodes.add(`oauth:${code}`);
        return ok(mintUserPair());
      },
    ],
    [
      "GET /app",
      () => ok({ id: 4242, slug: "pap-fake", name: "pap-fake", html_url: `${origin}/apps/pap-fake` }),
    ],
    [
      "GET /repos/:o/:r/installation",
      (p) => (state.repos.has(`${p.o}/${p.r}`) ? ok({ id: p.o === login ? 7 : 8 }) : error(404, "Not Found")),
    ],
    [
      "POST /app/installations/:id/access_tokens",
      (p, body) => {
        const asked = (body.permissions ?? state.appPermissions) as Record<string, string>;
        for (const name of Object.keys(asked))
          if (!(name in state.appPermissions))
            return error(422, `permission ${name} is not granted to the App`);
        const names = (body.repositories ?? [...state.repos.keys()].map((n) => n.split("/")[1])) as string[];
        // Installation 7 is the user's account, 8 anyone else's: a name matches inside one account only.
        const repositories = [...state.repos.values()].filter(
          (r) =>
            names.includes(r.fullName.split("/")[1] ?? "") &&
            (r.fullName.split("/")[0] === login) === (p.id === "7"),
        );
        const token = `ghs_${randomBytes(8).toString("hex")}`;
        state.minted.push({ token, permissions: asked, repositories: repositories.map((r) => r.fullName) });
        return ok(
          {
            token,
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            permissions: asked,
            repository_selection: "selected",
            repositories: repositories.map((r) => ({
              name: r.fullName.split("/")[1],
              full_name: r.fullName,
            })),
          },
          201,
        );
      },
    ],
    [
      "GET /repos/:o/:r",
      (p, _body, request) => {
        const repo = state.repos.get(`${p.o}/${p.r}`);
        const token = bearerOf(request.headers.authorization);
        const permissions = repo ? state.access.permissionsFor(repo.fullName, token) : null;
        return repo && permissions ? ok({ ...repoJson(repo), permissions }) : error(404, "Not Found");
      },
    ],
    ["GET /user", () => ok({ login, id: 1, name: "Octo Cat", email: null })],
    ["GET /user/installations", () => ok({ total_count: 1, installations: [{ id: 7, account: { login } }] })],
    [
      "GET /user/installations/:id/repositories",
      () => ok({ total_count: state.repos.size, repositories: [...state.repos.values()].map(repoJson) }),
    ],
    [
      "POST /repos/:o/:r/forks",
      (p, _body, request) => {
        const source = state.repos.get(`${p.o}/${p.r}`);
        if (!source || !state.access.permissionsFor(source.fullName, bearerOf(request.headers.authorization)))
          return error(404, "Not Found");
        const fullName = `${login}/${p.r}`;
        const existing = state.repos.get(fullName);
        if (existing) return ok(repoJson(existing), 202);
        const bare = join(dir, `${fullName.replace("/", "__")}.git`);
        makeBare(bare, source.bare);
        const fork = { fullName, private: false, defaultBranch: source.defaultBranch, bare };
        state.repos.set(fullName, fork);
        return ok(repoJson(fork), 202);
      },
    ],
    [
      "POST /user/ssh_signing_keys",
      (_p, body) => {
        const key = String(body.key ?? "");
        if ([...state.signingKeys.values()].some((k) => k.key === key))
          return error(422, "key is already in use");
        const id = next();
        state.signingKeys.set(id, { title: String(body.title ?? ""), key });
        return ok({ id, key, title: body.title }, 201);
      },
    ],
    [
      "DELETE /user/ssh_signing_keys/:id",
      (p) => (state.signingKeys.delete(Number(p.id)) ? { status: 204 } : error(404, "Not Found")),
    ],
    ["GET /repos/:o/:r/pulls", (p) => ok(state.data.pulls.get(`${p.o}/${p.r}`) ?? [])],
    [
      "GET /repos/:o/:r/commits/:ref/check-runs",
      (p) => {
        const runs = state.data.checkRuns.get(`${p.o}/${p.r}@${p.ref}`) ?? [];
        return ok({ total_count: runs.length, check_runs: runs });
      },
    ],
    [
      "GET /repos/:o/:r/actions/jobs/:id/logs",
      (p) => {
        const key = `${p.o}/${p.r}#${p.id}`;
        const location = state.data.logLocations.get(key);
        return location
          ? { status: 302, headers: { location } }
          : { status: 200, body: state.data.jobLogs.get(key) ?? "" };
      },
    ],
    ["GET /blob/:id", (p) => ({ status: 200, body: state.data.blobs.get(p.id ?? "") ?? "" })],
    ["GET /repos/:o/:r/issues", (p) => ok(state.data.issues.get(`${p.o}/${p.r}`) ?? [])],
    [
      "GET /repos/:o/:r/issues/:n",
      (p) => {
        const found = (state.data.issues.get(`${p.o}/${p.r}`) ?? []).find(
          (issue) => (issue as { number?: number }).number === Number(p.n),
        );
        return found ? ok(found) : error(404, "Not Found");
      },
    ],
    ["GET /repos/:o/:r/releases", (p) => ok(state.data.releases.get(`${p.o}/${p.r}`) ?? [])],
    ...apiRoutes(state, () => origin, next),
  ];

  const serve = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const method = request.method ?? "GET";
    const body = await readBody(request);
    const path = url.pathname;
    const call: FakeGithubCall = {
      method,
      path,
      route: null,
      query: url.search.slice(1),
      body,
      authorization: request.headers.authorization ?? null,
      error: null,
    };
    calls.push(call);
    let answer: FakeGithubResponse = error(404, "Not Found");
    try {
      let params: Record<string, string> = {};
      let handler: Handler | null = null;
      if (path === "/settings/apps/new") {
        call.route = `${method} /settings/apps/new`;
        handler = () => {
          const manifest = body.manifest ?? url.searchParams.get("manifest");
          if (typeof manifest === "string") state.manifests.push(manifest);
          return ok({ received: true });
        };
      } else {
        for (const [pattern, candidate] of routes) {
          const found = match(pattern, method, path);
          if (found) {
            call.route = pattern;
            params = found;
            handler = candidate;
            break;
          }
        }
      }
      const forced = call.route ? overrides.get(call.route) : undefined;
      if (forced && forced.times > 0) {
        forced.times -= 1;
        answer = forced.response;
      } else if (handler) answer = handler(params, body, request);
    } catch (thrown) {
      const detail = thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : "unknown";
      call.error = detail;
      answer = error(thrown instanceof URIError ? 400 : 500, detail);
    }
    const text =
      answer.body === undefined
        ? ""
        : typeof answer.body === "string"
          ? answer.body
          : JSON.stringify(answer.body);
    response.writeHead(answer.status, {
      "content-type": typeof answer.body === "string" ? "text/plain" : "application/json",
      ...answer.headers,
    });
    response.end(text);
  };

  const server = createServer((request, response) => {
    // Git over smart HTTP (a box clones and pushes for real); every other path is the API.
    if (serveGit(request, response, { repos: state.repos, minted: state.minted, calls })) return;
    serve(request, response).catch(() => void response.writeHead(500).end());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake github: no address");
  origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    state,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
