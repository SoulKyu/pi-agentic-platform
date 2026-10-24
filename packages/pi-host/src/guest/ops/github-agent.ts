import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { agentSocketOf, type GithubDeps, keyOf } from "./github-env.ts";
import { OpError } from "./paths.ts";

const AGENT_TIMEOUT_MS = 15_000;
/** The agents this guest started, by socket: they stay in the guest's process group, so they leave with it. */
const agents = new Map<string, ChildProcess>();

const run = (file: string, args: string[], socket: string): Promise<number> =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { encoding: "utf8", timeout: AGENT_TIMEOUT_MS, env: { PATH: process.env.PATH, SSH_AUTH_SOCK: socket } },
      (error) => {
        if (!error) return resolve(0);
        const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
        return typeof code === "number" ? resolve(code) : reject(new OpError("failed"));
      },
    );
  });

/** `ssh-add -l` answers 0 or 1 (no identity yet) from a live agent, 2 when nothing answers on the socket. */
const alive = async (socket: string): Promise<boolean> =>
  existsSync(socket) && (await run("ssh-add", ["-l"], socket)) !== 2;

/** Runs `ssh-agent` in the foreground as a child (its first line says the socket is bound). */
const start = (socket: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn("ssh-agent", ["-D", "-a", socket], { stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new OpError("timeout"));
    }, AGENT_TIMEOUT_MS);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new OpError("failed"));
    });
    child.once("exit", () => {
      clearTimeout(timer);
      if (agents.get(socket) === child) agents.delete(socket);
      reject(new OpError("failed"));
    });
    child.stdout.once("data", () => {
      clearTimeout(timer);
      child.removeAllListeners("exit");
      child.once("exit", () => {
        if (agents.get(socket) === child) agents.delete(socket);
      });
      child.stdout.resume();
      agents.set(socket, child);
      resolve();
    });
  });

/**
 * Starts the box's signing agent (guest root, socket in `/run/pap-github`) when none answers, and loads the signing key into
 * it. A box with no key has none to load. The private key stays in the box's guest-only folder: a session reaches the
 * agent's socket to ask for a signature while the project is linked, never the key.
 */
export async function ensureSigningAgent(deps: GithubDeps): Promise<void> {
  const key = keyOf(deps);
  if (!existsSync(key)) return;
  const socket = agentSocketOf(deps);
  if (!(await alive(socket))) {
    rmSync(socket, { force: true });
    mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
    await start(socket);
  }
  if ((await run("ssh-add", [key], socket)) !== 0) throw new OpError("failed");
}

/** Stops the box's signing agent, if this guest started one. */
export function stopSigningAgent(deps: GithubDeps): void {
  const socket = agentSocketOf(deps);
  agents.get(socket)?.kill("SIGTERM");
  agents.delete(socket);
  rmSync(socket, { force: true });
}
