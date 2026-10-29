import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { parseBoxKey, VmLayout } from "@pap/contracts/pi-host";
import { errorClass } from "../bounded.ts";
import { growFilesystem } from "./grow.ts";
import { runGuest } from "./guest.ts";
import { KATA_LAYOUT, KATA_PROJECT_LAYOUT } from "./kata-layout.ts";
import { BUNDLE_BIN } from "./ops/github-env.ts";
import { ensureSigningAgent } from "./ops/github-agent.ts";
import { createAgentGuestOps } from "./ops/agent.ts";
import { createGuestOps } from "./ops/index.ts";
import { bwrapLauncher, plainLauncher } from "./services/launcher.ts";
import { openNetns, procNetnsFiles, startNsDialer } from "./services/ns-dial.ts";
import { createNsDialerPool } from "./services/ns-pool.ts";
import { procReader } from "./services/ownership.ts";
import { createServiceHost } from "./services/supervisor.ts";
import { takeGatewayToken } from "./scrub.ts";
import { pickPackages, seedAgentFolder } from "./seed.ts";

/** `pap-guest`, the VM's entrypoint. The token is scrubbed from the environment before anything else runs (R24). */
const fail = (message: string): never => {
  process.stderr.write(`pap-guest: ${message}\n`);
  process.exit(70);
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

// A project box mounts at /boxes/<id>, not /agent.
const box = parseBoxKey(process.env.PAP_BOX ?? "");
let layout: VmLayout = box?.kind === "project" ? KATA_PROJECT_LAYOUT(box.id) : KATA_LAYOUT;
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

const githubDeps = layout.project
  ? {
      home: layout.home,
      runDir: process.env.PAP_GUEST_RUN_DIR ?? "/run",
      binDir: BUNDLE_BIN,
      env: process.env,
    }
  : null;
// A box that already has a signing key gets its agent back at boot (the agent does not survive a VM stop).
if (githubDeps) {
  await ensureSigningAgent(githubDeps).catch(() => process.stderr.write("pap-guest: signing agent failed\n"));
}

const guestClock = {
  now: () => Date.now(),
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};
const guestLog = (line: string): void => void process.stderr.write(`pap-guest: ${line}\n`);
// The plain launcher is the process backend's only (tests, UX2-R20): it needs both its layout and its own marker.
const plainServices = Boolean(process.env.PAP_GUEST_LAYOUT) && process.env.PAP_GUEST_SERVICES === "plain";

// A service without network is entered through one helper per namespace (UX2-R22); the plain launcher shares the guest's.
const nsDialer = plainServices
  ? undefined
  : createNsDialerPool({
      clock: guestClock,
      open: (target) => openNetns(target, procNetnsFiles),
      start: (nsFd) => startNsDialer({ nsFd, spawn, clock: guestClock, log: guestLog }),
      closeFd: closeSync,
      log: guestLog,
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
      cwd: layout.project ?? layout.home,
      stdio: ["ignore", "pipe", "pipe", "pipe"],
      // Its own process group: `signal` reaches the worker and what it started.
      detached: true,
    }),
  ops:
    layout.project && githubDeps
      ? createGuestOps(layout.project, () => Date.now(), githubDeps)
      : createAgentGuestOps(layout.root, () => Date.now()),
  services: (report) =>
    createServiceHost({
      layout,
      env: process.env,
      clock: guestClock,
      launcher: plainServices ? plainLauncher() : bwrapLauncher(guestLog),
      proc: procReader(),
      ...(nsDialer ? { nsDialer } : {}),
      report,
      log: guestLog,
    }),
  clock: guestClock,
  seed: () => seedAgentFolder(layout, guestLog),
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
  log: guestLog,
  // The process backend stops a box with SIGTERM to the guest's group: services (own sessions) must not outlive it.
  onTerminate: (handler) => void process.once("SIGTERM", handler),
});
