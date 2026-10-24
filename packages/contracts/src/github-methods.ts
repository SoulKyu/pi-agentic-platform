import { z } from "zod";
import { defineMethod } from "./define.ts";
import type { ErrorCode } from "./errors.ts";
import { GITHUB_LIMITS, GithubStatusView, ProjectGithubView, RepoFullName } from "./github.ts";
import { ProjectView } from "./shell.ts";

const Id = z.string().min(1).max(128);
const Params = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const Ok = z.object({ ok: z.literal(true) }).strict();

/** What every call that reaches GitHub can refuse with, beside its own. */
const GITHUB_ERRORS = ["github_unavailable", "network", "read_only"] as const satisfies readonly ErrorCode[];
const BOX_ERRORS = [
  "not_found",
  "box_stopped",
  "command_failed",
  "timeout",
  "capacity",
] as const satisfies readonly ErrorCode[];

export const githubMethods = {
  "github.status": defineMethod({
    name: "github.status",
    permission: "settings:read",
    idempotent: true,
    params: Params({}),
    result: Params({ status: GithubStatusView }),
    errors: [],
  }),
  /** The browser posts `manifest` to `postUrl` (GitHub's manifest flow); `state` comes back on the callback, single use. */
  "github.startCreate": defineMethod({
    name: "github.startCreate",
    permission: "settings:admin",
    idempotent: false,
    params: Params({}),
    result: Params({
      postUrl: z.string().url().max(2048),
      manifest: z.string().max(8192),
      state: z.string().regex(/^[0-9a-f]{32}$/),
    }),
    errors: ["conflict", "read_only", "internal"],
  }),
  "github.authorizeUrl": defineMethod({
    name: "github.authorizeUrl",
    permission: "settings:admin",
    idempotent: false,
    params: Params({}),
    result: Params({ url: z.string().url().max(2048) }),
    errors: ["github_unavailable", "read_only", "internal"],
  }),
  "github.disconnect": defineMethod({
    name: "github.disconnect",
    permission: "settings:admin",
    idempotent: false,
    params: Params({}),
    result: Ok,
    errors: ["github_unavailable", "read_only"],
  }),
  /** Deletes the App file and every GitHub token pap holds. Asks the password again. */
  "github.forget": defineMethod({
    name: "github.forget",
    permission: "settings:admin",
    idempotent: false,
    params: Params({}),
    result: Ok,
    errors: ["step_up_required", "read_only"],
  }),
  "github.repositories": defineMethod({
    name: "github.repositories",
    permission: "sessions:operate",
    idempotent: true,
    params: Params({ query: z.string().max(128).optional() }),
    result: Params({
      repositories: z
        .array(
          Params({
            fullName: RepoFullName,
            private: z.boolean(),
            defaultBranch: z.string().min(1).max(256),
          }),
        )
        .max(GITHUB_LIMITS.repositories),
    }),
    errors: [...GITHUB_ERRORS],
  }),
  "projects.createFromGithub": defineMethod({
    name: "projects.createFromGithub",
    permission: "sessions:operate",
    idempotent: false,
    params: Params({
      repository: RepoFullName,
      mode: z.enum(["clone", "fork"]),
      name: z.string().min(1).max(256).optional(),
    }),
    result: Params({ project: ProjectView }),
    errors: ["bad_request", "capacity", "not_found", "disk_low", "sandbox_unavailable", ...GITHUB_ERRORS],
  }),
  "projects.linkGithub": defineMethod({
    name: "projects.linkGithub",
    permission: "sessions:operate",
    idempotent: false,
    params: Params({ projectId: Id, repository: RepoFullName }),
    result: Params({ github: ProjectGithubView }),
    errors: [...BOX_ERRORS, "bad_request", "conflict", ...GITHUB_ERRORS],
  }),
  "projects.unlinkGithub": defineMethod({
    name: "projects.unlinkGithub",
    permission: "sessions:operate",
    idempotent: false,
    params: Params({ projectId: Id }),
    result: Ok,
    errors: [...BOX_ERRORS, "read_only"],
  }),
  "projects.cloneAgain": defineMethod({
    name: "projects.cloneAgain",
    permission: "sessions:operate",
    idempotent: false,
    params: Params({ projectId: Id }),
    result: Ok,
    errors: [...BOX_ERRORS, "conflict", ...GITHUB_ERRORS],
  }),
  "projects.commitPush": defineMethod({
    name: "projects.commitPush",
    permission: "sessions:operate",
    idempotent: false,
    params: Params({ projectId: Id, message: z.string().min(1).max(4096) }),
    result: Params({ sha: z.string().nullable(), branch: z.string().min(1).max(256) }),
    errors: [...BOX_ERRORS, "bad_request", ...GITHUB_ERRORS],
  }),
  "projects.prCreate": defineMethod({
    name: "projects.prCreate",
    permission: "sessions:operate",
    idempotent: false,
    params: Params({
      projectId: Id,
      title: z.string().min(1).max(256),
      body: z.string().max(GITHUB_LIMITS.body),
      base: z.string().min(1).max(256).optional(),
    }),
    result: z.discriminatedUnion("kind", [
      Params({
        kind: z.literal("created"),
        number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        url: z.string().url().max(2048),
      }),
      Params({ kind: z.literal("compare"), url: z.string().url().max(2048) }),
    ]),
    errors: [...BOX_ERRORS, "bad_request", ...GITHUB_ERRORS],
  }),
  /** A token may call this: it reads the lists the daemon cached, all text GitHub-written. */
  "projects.github": defineMethod({
    name: "projects.github",
    permission: "sessions:read",
    idempotent: true,
    params: Params({ projectId: Id }),
    result: Params({ github: ProjectGithubView }),
    errors: ["not_found", "github_unavailable", "network"],
  }),
  "projects.checkLog": defineMethod({
    name: "projects.checkLog",
    permission: "sessions:read",
    idempotent: true,
    params: Params({ projectId: Id, checkId: z.string().min(1).max(GITHUB_LIMITS.name) }),
    result: Params({ text: z.string().max(GITHUB_LIMITS.checkLogBytes * 4), truncated: z.boolean() }),
    errors: ["not_found", "github_unavailable", "network"],
  }),
  "projects.sendToSession": defineMethod({
    name: "projects.sendToSession",
    permission: "sessions:operate",
    idempotent: false,
    params: Params({
      projectId: Id,
      source: z.discriminatedUnion("kind", [
        Params({ kind: z.literal("check"), checkId: z.string().min(1).max(GITHUB_LIMITS.name) }),
        Params({
          kind: z.literal("issue"),
          number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        }),
      ]),
      sessionId: Id.optional(),
    }),
    result: Params({ sessionId: Id }),
    errors: ["not_found", "capacity", "session_busy", ...GITHUB_ERRORS],
  }),
} as const;

/**
 * Methods a token may not call (a `forbidden` answer) although their permission is one a token can hold: `defineMethod`
 * has no marker for it and `TOKEN_PERMISSIONS` works per permission, so the daemon checks this set. Everything here
 * except the three read methods below.
 */
export const GITHUB_TOKEN_METHODS: ReadonlySet<string> = new Set([
  "github.status",
  "projects.github",
  "projects.checkLog",
]);
export const GITHUB_BROWSER_ONLY: ReadonlySet<string> = new Set(
  Object.keys(githubMethods).filter((name) => !GITHUB_TOKEN_METHODS.has(name)),
);
