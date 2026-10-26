import { execFile } from "node:child_process";
import { FILE_LIMITS, INVISIBLE, rank } from "@pap/contracts/pi-host";
import { runGit } from "./git-run.ts";
import { OpError, type OpEnv } from "./paths.ts";

/** The files module's caps for one index. */
const INDEX_LIMITS = { ttlMs: 30_000, paths: 100_000, gitBytes: 8 * 1024 * 1024, walkMs: 5000 } as const;

interface PathIndex {
  readonly paths: readonly string[];
  readonly truncated: boolean;
}

/** A mention carries the path into a prompt: a name that can hide text never enters the index; a folder entry is not a file. */
function indexable(path: string): boolean {
  return (
    path !== "" &&
    !path.endsWith("/") &&
    path.length <= FILE_LIMITS.pathBytes &&
    !INVISIBLE.test(path) &&
    !/\p{Surrogate}/u.test(path)
  );
}

function indexOf(listing: Buffer, hidden: readonly string[]): PathIndex {
  const paths: string[] = [];
  let truncated = false;
  for (const path of listing.toString("utf8").split("\0")) {
    if (!indexable(path) || hidden.includes(path.split("/")[0] ?? "")) continue;
    if (paths.length === INDEX_LIMITS.paths) {
      truncated = true;
      break;
    }
    paths.push(path);
  }
  return { paths, truncated };
}

/** Outside a repository: ripgrep lists the files (hidden ones too, `.git` never). */
const ripgrepFiles = (project: string, hidden: readonly string[]): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    execFile(
      "rg",
      [
        "--files",
        "--null",
        "--hidden",
        "--glob",
        "!.git",
        ...hidden.flatMap((name) => ["--glob", `!/${name}`]),
        "--no-messages",
      ],
      {
        cwd: project,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C" },
        encoding: "buffer",
        maxBuffer: INDEX_LIMITS.gitBytes,
        timeout: INDEX_LIMITS.walkMs,
      },
      // rg exits 1 when it found nothing and 2 on a partial error; either way its output is what there is.
      (error, stdout) => {
        const code = (error as { code?: unknown } | null)?.code;
        if (error === null || code === 1 || code === 2) resolve(stdout);
        else reject(new OpError(code === "ENOENT" ? "failed" : "timeout"));
      },
    );
  });

export interface Search {
  /** `fs.search`: the `@` mention search over the project's files, paths relative to the project root, best first. */
  run(
    env: OpEnv,
    args: { readonly query: string; readonly limit: number },
  ): Promise<{ paths: string[]; truncated: boolean }>;
}

export function createSearch(): Search {
  let cached: { at: number; index: Promise<PathIndex> } | undefined;

  const build = async (env: OpEnv): Promise<PathIndex> => {
    const hidden = env.hidden ?? [];
    try {
      const listed = await runGit(
        env.project,
        [
          "ls-files",
          "-z",
          "--cached",
          "--others",
          "--exclude-standard",
          "--",
          ".",
          ...hidden.map((name) => `:(exclude,literal)${name}`),
        ],
        {
          maxBytes: INDEX_LIMITS.gitBytes,
        },
      );
      return indexOf(listed.stdout, hidden);
    } catch (error) {
      // Only git's own failures fall back to ripgrep; a cap or a timeout is the caller's to hear about.
      if (error instanceof OpError && error.code !== "failed") throw error;
      return indexOf(await ripgrepFiles(env.project, hidden), hidden);
    }
  };

  return {
    async run(env, args) {
      const now = env.now();
      if (cached === undefined || now - cached.at >= INDEX_LIMITS.ttlMs) {
        const entry = { at: now, index: build(env) };
        cached = entry;
        entry.index.catch(() => {
          if (cached === entry) cached = undefined;
        });
      }
      const found = await cached.index;
      const ranked = rank(found.paths, args.query, args.limit);
      return { paths: ranked.paths, truncated: ranked.more || found.truncated };
    },
  };
}
