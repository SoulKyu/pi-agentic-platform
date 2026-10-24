import { mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { IncomingMessage } from "node:http";

export type Json = Record<string, unknown>;

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const GIT_ENV = {
  PATH: process.env.PATH,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "fake",
  GIT_AUTHOR_EMAIL: "fake@example.invalid",
  GIT_COMMITTER_NAME: "fake",
  GIT_COMMITTER_EMAIL: "fake@example.invalid",
};
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    env: GIT_ENV,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

export function makeBare(dir: string, from: string | null): void {
  if (from) {
    execFileSync("git", ["clone", "--bare", "--quiet", from, dir], { env: GIT_ENV, stdio: "ignore" });
    return;
  }
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "--bare", "--quiet", "-b", "main");
  execFileSync("git", ["hash-object", "-t", "tree", "-w", "--stdin"], { cwd: dir, env: GIT_ENV, input: "" });
  const commit = git(dir, "commit-tree", EMPTY_TREE, "-m", "initial");
  git(dir, "update-ref", "refs/heads/main", commit);
}

export function readBody(request: IncomingMessage): Promise<Json> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= 1_048_576) chunks.push(chunk);
    });
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(
          text.startsWith("{") ? (JSON.parse(text) as Json) : Object.fromEntries(new URLSearchParams(text)),
        );
      } catch {
        resolve({});
      }
    });
  });
}

export function match(pattern: string, method: string, path: string): Record<string, string> | null {
  const [pm, pp] = pattern.split(" ") as [string, string];
  if (pm !== method) return null;
  const want = pp.split("/");
  const have = path.split("/");
  if (want.length !== have.length) return null;
  const params: Record<string, string> = {};
  for (const [i, part] of want.entries()) {
    if (part.startsWith(":")) params[part.slice(1)] = decodeURIComponent(have[i] ?? "");
    else if (part !== have[i]) return null;
  }
  return params;
}
