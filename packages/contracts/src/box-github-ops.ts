import { z } from "zod";

const op = <N extends string, S extends z.ZodRawShape>(name: N, shape: S) =>
  z.object({ name: z.literal(name), ...shape }).strict();

/**
 * A clone or link URL: `https://github.com/<owner>/<repo>.git`. The loopback forms exist for the fake GitHub of the tests
 * (an `http://127.0.0.1` origin, a local bare repository by `file://`); the daemon refuses them outside test mode.
 */
const GITHUB_HTTPS = /^https:\/\/github\.com\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}\.git$/;
const TEST_ORIGIN = /^(?:http:\/\/127\.0\.0\.1:\d{1,5}|file:\/\/)\/[A-Za-z0-9._/-]{1,512}$/;
export const GitRemoteUrl = z
  .string()
  .max(1024)
  .refine(
    (url) => (GITHUB_HTTPS.test(url) || TEST_ORIGIN.test(url)) && !url.includes(".."),
    "a GitHub https URL",
  );

const Branch = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._/-]+$/)
  .refine((name) => !name.startsWith("-") && !name.includes(".."), "a plain branch name");
const Ok = z.object({ ok: z.literal(true) }).strict();
const Token = z.string().min(1).max(512).regex(/^\S+$/);

export const BOX_GITHUB_OPS = [
  op("git.clone", { url: GitRemoteUrl, upstream: GitRemoteUrl.nullable() }),
  op("git.link", { url: GitRemoteUrl }),
  op("git.unlink", {}),
  op("git.commit", { message: z.string().min(1).max(4096) }),
  op("git.push", {}),
  op("github.token", { token: Token, expiresAt: z.string().max(64) }),
  op("github.identity", {
    login: z.string().min(1).max(64),
    /** `name` is the op's discriminator, so the git user name is `displayName` here. */
    displayName: z.string().min(1).max(256),
    email: z.string().min(1).max(256),
  }),
  op("github.forgetKey", {}),
] as const;

export const BOX_GITHUB_RESULTS = {
  "git.clone": z.object({ branch: Branch }).strict(),
  "git.link": Ok,
  "git.unlink": Ok,
  "git.commit": z
    .object({
      sha: z
        .string()
        .regex(/^[0-9a-f]{7,64}$/)
        .nullable(),
    })
    .strict(),
  "git.push": z.object({ branch: Branch, remote: z.string().min(1).max(64) }).strict(),
  "github.token": Ok,
  "github.identity": z.object({ publicKey: z.string().min(1).max(1024) }).strict(),
  "github.forgetKey": Ok,
} as const;

/** The ops that clone, push or call GitHub take longer than the 30 s default. */
export const BOX_GITHUB_TIMEOUTS = Object.freeze({
  "git.clone": 600_000,
  "git.push": 120_000,
});
