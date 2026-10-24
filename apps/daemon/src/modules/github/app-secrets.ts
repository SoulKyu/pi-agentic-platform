import { closeSync, constants, fstatSync, openSync, readSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { PapError } from "@pap/contracts";
import { z } from "zod";
import { ensurePrivateFolder, PrivateFolderError, writePrivateFile } from "../../kernel/fs/private-write.ts";
import type { Logger } from "../../kernel/logger.ts";

export const GITHUB_APP_FILE = "github-app.json";
/** The App file: an id, a slug, a client pair and a PEM key are a few KiB. */
export const GITHUB_APP_MAX_BYTES = 16 * 1024;

const AUTHORIZED_ORIGINS_MAX = 8;

export const GithubAppFile = z
  .object({
    appId: z.number().int().positive(),
    slug: z.string().min(1).max(256),
    clientId: z.string().min(1).max(256),
    clientSecret: z.string().min(1).max(512),
    privateKey: z.string().min(1).max(8192),
    htmlUrl: z.string().url().max(2048),
    /** The origin pap was reached at when the App was created: its callback URLs are built on it. */
    callbackOrigin: z.string().url().max(2048),
    /** Other origins GitHub accepted as the sign-in callback (the owner added their callback URLs on the App). */
    authorizedOrigins: z.array(z.string().url().max(2048)).max(AUTHORIZED_ORIGINS_MAX).optional(),
  })
  .strict();
export type GithubAppFile = z.infer<typeof GithubAppFile>;

/** What status shows: never a key or a secret. */
export interface GithubAppStatus {
  readonly slug: string;
  readonly htmlUrl: string;
  readonly callbackOrigin: string;
  readonly authorizedOrigins: readonly string[];
}

export interface AppSecretsStore {
  /** The stored App, or null: absent, a link, oversized or invalid all read as none (the class is logged). */
  load(): GithubAppFile | null;
  /** Never carries a value. */
  status(): GithubAppStatus | null;
  save(app: GithubAppFile): void;
  /** Remembers an origin GitHub accepted as the sign-in callback (the newest eight are kept). */
  addAuthorizedOrigin(origin: string): void;
  forget(): void;
  /** The values value redaction must know: the client secret and the key (whole and its body). */
  secretValues(): string[];
}

const errorClass = (error: unknown): string => (error as NodeJS.ErrnoException | null)?.code ?? "error";

/** Whole file without following a link: `null` for absent; a fixed reason through `fail` for anything else. */
function readAppFile(path: string, fail: (reason: string) => null): GithubAppFile | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : fail(errorClass(error));
  }
  let app: GithubAppFile | null = null;
  let reason: string | null = null;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > GITHUB_APP_MAX_BYTES) reason = "not_an_app_file";
    else {
      const buffer = Buffer.alloc(stat.size);
      let read = 0;
      while (read < stat.size) {
        const count = readSync(fd, buffer, read, stat.size - read, read);
        if (count === 0) break;
        read += count;
      }
      try {
        const parsed = GithubAppFile.safeParse(JSON.parse(buffer.subarray(0, read).toString("utf8")));
        if (parsed.success) app = parsed.data;
        else reason = "not_an_app";
      } catch {
        reason = "not_an_app";
      }
    }
  } catch (error) {
    reason = errorClass(error);
  } finally {
    closeSync(fd);
  }
  return reason === null ? app : fail(reason);
}

/** `$PAP_HOME/secrets/github-app.json`, the claude-token pattern: 0600 in a 0700 folder, opened without a link, 16 KiB at most. */
export function createAppSecrets(deps: {
  readonly secretsDir: string;
  readonly logger: Logger;
}): AppSecretsStore {
  const { secretsDir, logger } = deps;
  const path = join(secretsDir, GITHUB_APP_FILE);
  const load = (): GithubAppFile | null =>
    readAppFile(path, (reason) => {
      logger.warn("github_app_unreadable", { err: reason });
      return null;
    });
  return {
    load,
    status() {
      const app = load();
      return (
        app && {
          slug: app.slug,
          htmlUrl: app.htmlUrl,
          callbackOrigin: app.callbackOrigin,
          authorizedOrigins: app.authorizedOrigins ?? [],
        }
      );
    },
    addAuthorizedOrigin(origin) {
      const app = load();
      if (!app || (app.authorizedOrigins ?? []).includes(origin)) return;
      this.save({
        ...app,
        authorizedOrigins: [...(app.authorizedOrigins ?? []), origin].slice(-AUTHORIZED_ORIGINS_MAX),
      });
    },
    save(app) {
      const bytes = Buffer.from(JSON.stringify(GithubAppFile.parse(app)), "utf8");
      if (bytes.length > GITHUB_APP_MAX_BYTES) throw new PapError("internal");
      try {
        ensurePrivateFolder(secretsDir);
        writePrivateFile(path, bytes);
      } catch (error) {
        logger.error("github_app_write_failed", {
          err: error instanceof PrivateFolderError ? error.reason : errorClass(error),
        });
        throw new PapError("internal");
      }
      logger.info("github_app_saved");
    },
    forget() {
      try {
        unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          logger.error("github_app_forget_failed", { err: errorClass(error) });
          throw new PapError("internal");
        }
      }
      logger.info("github_app_forgotten");
    },
    secretValues() {
      const app = load();
      if (!app) return [];
      const body = app.privateKey
        .split("\n")
        .filter((line) => line !== "" && !line.startsWith("-----"))
        .join("");
      return [app.clientSecret, app.privateKey, ...(body.length > 0 ? [body] : [])];
    },
  };
}

/** For the owner-secrets collector, which has no module instance: the App's secret values, or none when the file is not good. */
export function githubAppSecretValues(secretsDir: string, logger: Logger): string[] {
  return createAppSecrets({ secretsDir, logger }).secretValues();
}
