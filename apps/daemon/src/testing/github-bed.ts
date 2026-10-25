import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { MethodName, ParamsOf, ProjectGithubView, ProjectView, ResultOf } from "@pap/contracts";
import { vi } from "vitest";
import { type FakeGithub, startFakeGithub } from "../kernel/testing/fake-github.ts";
import { rows } from "../security/testing/automation-bed.ts";
import { type BoxBed, startBoxBed } from "./box-bed.ts";
import { captureLogger } from "./capture-logger.ts";
import { httpRequest } from "./http-client.ts";

/** The App's client secret the fake hands out at the manifest conversion: known, so a test can grep for it. */
export const CLIENT_SECRET = "journey-client-secret-0123456789abcdef";

export interface GithubBoxBed extends BoxBed {
  readonly fake: FakeGithub;
  /** The daemon's log lines, as parsed JSON. */
  readonly logLines: Array<Record<string, unknown>>;
  /** Every RPC answer (result or error frame) the helpers received, as JSON text. */
  readonly answers: string[];
  /** The App's private key as the fake handed it out (PEM). */
  readonly pem: string;
  /** An RPC that must succeed; the answer is recorded. */
  ask<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>>;
  /** The answer of an RPC whatever it is: `ok` or the error code. */
  code<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<string>;
  /** Create the App through the manifest flow and authorize the owner (the fake plays GitHub). */
  connectApp(): Promise<void>;
  /** `projects.createFromGithub`, then the box start and the wait for the clone to finish. */
  cloneProject(repository: string, mode?: "clone" | "fork"): Promise<ProjectView>;
  /** `projects.github` now. */
  githubOf(projectId: string): Promise<ProjectGithubView>;
  /** Writes a file in the project through Files (the box is running). */
  writeFile(project: ProjectView, name: string, text: string): Promise<void>;
  /** Every value a GitHub secret has taken in this run: the PEM (whole and its body), the client secret, the user and refresh tokens, the installation tokens. */
  secretValues(): string[];
  /** Files below the daemon's temporary root that hold `value`, outside the box's `/run`. */
  filesHolding(value: string): string[];
}

/**
 * A whole daemon on the process backend with the fake GitHub on loopback: `PAP_TEST_GITHUB_ORIGIN` is the config value
 * (`testGithubOrigin`), and git speaks smart HTTP to it for real.
 */
export async function startGithubBoxBed(
  script: object = { steps: [] },
  options: Parameters<typeof startBoxBed>[1] = {},
): Promise<GithubBoxBed> {
  const fake = await startFakeGithub();
  const { privateKey: pem } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  // A real key signs the App's JWTs; the conversion answers it once.
  fake.state.respond(
    "POST /app-manifests/:code/conversions",
    {
      status: 201,
      body: {
        id: 4242,
        slug: "pap-fake",
        name: "pap-fake",
        client_id: "Iv1.fake",
        client_secret: CLIENT_SECRET,
        webhook_secret: null,
        pem,
        html_url: `${fake.origin}/apps/pap-fake`,
        owner: { login: fake.state.login },
      },
    },
    1,
  );
  const { logger, lines } = captureLogger();
  let bed: BoxBed;
  try {
    bed = await startBoxBed(script, {
      ...options,
      config: { ...options.config, testGithubOrigin: fake.origin },
      deps: { ...options.deps, logger },
    });
  } catch (error) {
    await fake.close();
    throw error;
  }
  const answers: string[] = [];
  const record = (frame: unknown): void => void answers.push(JSON.stringify(frame));
  const raw = async (method: MethodName, params: object) => {
    const frame = await bed.owner.client.call(method, params as ParamsOf<typeof method>);
    record(frame);
    return frame;
  };
  const ask = async <M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> => {
    const frame = await raw(method, params);
    if (!frame.ok) throw new Error(`${method} failed: ${frame.error.code}`);
    return frame.result as ResultOf<M>;
  };
  const ownerHeaders = { cookie: bed.owner.cookie, origin: bed.t.origin };
  const get = (path: string, headers: Record<string, string> = {}) =>
    httpRequest(`${bed.t.base}${path}`, { headers });
  const githubOf = async (projectId: string): Promise<ProjectGithubView> =>
    (await ask("projects.github", { projectId })).github;

  const github: Omit<GithubBoxBed, keyof BoxBed | "fake" | "logLines" | "pem"> = {
    answers,
    ask,
    async code(method, params) {
      const frame = await raw(method, params);
      return frame.ok ? "ok" : frame.error.code;
    },
    async connectApp() {
      const start = await ask("github.startCreate", {});
      const page = await get(new URL(start.postUrl).pathname + new URL(start.postUrl).search, ownerHeaders);
      const state = /settings\/apps\/new\?state=([0-9a-f]{32})/.exec(page.body)?.[1];
      if (page.status !== 200 || state === undefined) throw new Error(`manifest page ${page.status}`);
      // The page's form posts the manifest to GitHub (the fake keeps it); GitHub sends the browser back, cross-site: no cookie, the state alone.
      await httpRequest(`${fake.origin}/settings/apps/new?state=${state}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ manifest: start.manifest }).toString(),
      });
      const created = await get(`/github/app/created?code=manifest-code&state=${state}`);
      if (created.status !== 200) throw new Error(`created callback ${created.status}`);
      const { url } = await ask("github.authorizeUrl", {});
      const authState = new URL(url).searchParams.get("state");
      const authorized = await get(`/github/app/authorized?code=user-code&state=${authState}`);
      if (authorized.status !== 200) throw new Error(`authorized callback ${authorized.status}`);
      const ticket = /finish\?ticket=([0-9a-f]{32})/.exec(authorized.body)?.[1];
      if (ticket === undefined) throw new Error("authorized callback: no ticket");
      // The page navigates on, same site, with the owner's cookie: that is what binds the token.
      const finished = await get(`/github/app/authorized/finish?ticket=${ticket}`, ownerHeaders);
      if (finished.status !== 200) throw new Error(`authorized finish ${finished.status}`);
    },
    githubOf,
    async cloneProject(repository, mode = "clone") {
      const { project } = await ask("projects.createFromGithub", {
        repository: repository as ParamsOf<"projects.createFromGithub">["repository"],
        mode,
      });
      await ask("projects.startBox", { projectId: project.id });
      await vi.waitFor(
        async () => {
          const view = await githubOf(project.id);
          if (view.clone?.state === "failed") throw new Error(`clone failed: ${view.clone.error}`);
          if (view.clone?.state !== "done") throw new Error("clone not done");
        },
        { timeout: 60_000, interval: 250 },
      );
      return project;
    },
    async writeFile(project, name, text) {
      await ask("files.write", { path: `${project.root}/${name}`, text, baseEtag: null });
    },
    secretValues() {
      const body = pem
        .split("\n")
        .filter((line) => line !== "" && !line.startsWith("-----"))
        .join("");
      const { access, refresh } = fake.state.userTokens;
      return [
        pem,
        body,
        CLIENT_SECRET,
        access,
        refresh,
        ...fake.state.minted.map((minted) => minted.token),
      ].filter((value) => value.length >= 8);
    },
    filesHolding(value) {
      const found: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) walk(path);
          else if (entry.isFile() && statSync(path).size <= 8 * 1024 * 1024) {
            if (path.endsWith("/pap-github/token")) continue;
            if (readFileSync(path).includes(value)) found.push(path);
          }
        }
      };
      walk(bed.t.root);
      return found;
    },
  };
  const stop = bed.stop.bind(bed);
  return Object.assign(bed, github, {
    fake,
    logLines: lines,
    pem,
    async stop() {
      try {
        await stop();
      } finally {
        await fake.close();
      }
    },
  });
}

/** A commit of the bare repository the fake serves, as git prints it (`git cat-file -p`). */
export function commitOf(bare: string, ref = "main"): string {
  return execFileSync("git", ["cat-file", "-p", ref], {
    cwd: bare,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
}

/** The audit table as text, for a grep. */
export const auditText = (home: string): string =>
  JSON.stringify(rows<Record<string, unknown>>(home, "SELECT * FROM audit"));
