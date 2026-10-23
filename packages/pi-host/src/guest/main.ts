import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { VmLayout } from "@pap/contracts";
import { errorClass } from "../bounded.ts";
import { growFilesystem } from "./grow.ts";
import { runGuest } from "./guest.ts";
import { takeGatewayToken } from "./scrub.ts";
import { pickPackages, seedAgentFolder } from "./seed.ts";

/** `pap-guest`, the VM's entrypoint. The token is scrubbed from the environment before anything else runs (R24). */
const fail = (message: string): never => {
  process.stderr.write(`pap-guest: ${message}\n`);
  process.exit(70);
};

/** Where things are under Kata; the process backend names its own folders in PAP_GUEST_LAYOUT (a VmLayout as JSON). */
const KATA_LAYOUT: VmLayout = {
  root: "/agent",
  home: "/agent/home",
  knowledge: "/agent/knowledge",
  inbox: "/agent/inbox",
  pi: "/agent/.pi",
  sessions: "/agent/.pi/sessions",
  piAgentDir: "/agent/.pi/agent",
  imageAgentDir: "/opt/pap/pi-agent",
  shellOverlay: "/run/pap-shell",
};

let token: string | null = null;
try {
  token = takeGatewayToken({
    env: process.env,
    // `/run` under Kata; the process backend gives its own temp `run/`.
    runDir: process.env.PAP_GUEST_RUN_DIR ?? "/run",
    execPath: process.execPath,
    execArgv: process.execArgv,
    argv: process.argv,
    execve: (file, args, env) => {
      // `process.execve` replaces this process: the token is in no environment block of the new image.
      (process.execve as NonNullable<typeof process.execve>)(file, args, env);
    },
  });
} catch (error) {
  fail(`the gateway token could not be taken (${errorClass(error)})`);
}
if (token === null) fail("the re-execution returned");

let layout: VmLayout = KATA_LAYOUT;
if (process.env.PAP_GUEST_LAYOUT) {
  try {
    layout = VmLayout.parse(JSON.parse(process.env.PAP_GUEST_LAYOUT));
  } catch {
    fail("PAP_GUEST_LAYOUT is not a valid layout");
  }
}
const piHost = fileURLToPath(
  new URL(import.meta.url.endsWith(".ts") ? "../main.ts" : "../main.js", import.meta.url),
);
const execFileText = (file: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf8", timeout: 120_000 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });

await runGuest({
  env: process.env,
  token: token as string,
  layout,
  connect: (address) => {
    const split = address.lastIndexOf(":");
    return net.connect({ host: address.slice(0, split), port: Number(address.slice(split + 1)) });
  },
  spawn: (_slot, env) =>
    spawn(process.execPath, [...process.execArgv, piHost], {
      env,
      cwd: layout.home,
      stdio: ["ignore", "pipe", "pipe", "pipe"],
      // Its own process group: `signal` reaches the worker and what it started.
      detached: true,
    }),
  clock: {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  },
  seed: () => seedAgentFolder(layout, (line) => void process.stderr.write(`pap-guest: ${line}\n`)),
  pick: (packages) => pickPackages(layout, packages),
  grow: async () => {
    await growFilesystem({
      root: layout.root,
      run: execFileText,
      node: {
        exists: existsSync,
        sectors: (name) => readFileSync(`/sys/class/block/${name}/size`, "utf8"),
      },
    });
  },
  exit: (code) => {
    process.exitCode = code;
    // Let the last frames leave; the timer is the backstop for a worker pipe that stays open.
    setTimeout(() => process.exit(code), 200);
  },
  signalGroup: (child, signal) => {
    try {
      if (child.pid === undefined) throw new Error("no pid");
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  },
  log: (line) => void process.stderr.write(`pap-guest: ${line}\n`),
});
