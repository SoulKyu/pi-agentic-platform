// Post-build smoke test of the install path (M6R28-M6R30): the built `pap service install` writes a unit and a launcher
// into a temporary HOME (fake systemctl, loginctl and journalctl first on PATH, so the real user manager is never
// reached), then the ExecStart= and Environment= lines of that unit are parsed back and spawned as they are. That pins
// the unit text (flag spellings, `serve`, PATH) against the real built daemon, which no mock can show.
// The archive method is not smoked here (M6R30). Run after `pnpm build`: `pnpm smoke:install`.
import { execFile, execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { STOP_DEADLINE_MS } from "../apps/daemon/src/shutdown.ts";
import {
  DAEMON,
  type Daemon,
  freePort,
  http,
  NETWORK_GUARD,
  REPO,
  startDaemon,
  step,
  STEP_MS,
  within,
} from "./smoke-lib.ts";

const WEB_INDEX = join(REPO, "apps/web/dist/index.html");
const INSTALL_MS = 60_000;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Executable fakes: only what `pap service install` asks of the three binaries, nothing else answers.
const FAKES: Record<string, string> = {
  systemctl: [
    'case "$*" in',
    "  *InvocationID*) echo 0123456789abcdef0123456789abcdef ;;",
    "  *is-active*) exit 3 ;;",
    "esac",
    "exit 0",
  ].join("\n"),
  loginctl: 'case "$1" in show-user) echo yes ;; esac\nexit 0',
  // The install path reads this journal for the listening line and the setup URL; the port-1 URL in them is ignored.
  journalctl: [
    `echo '{"msg":"listening","url":"http://localhost:1"}'`,
    `echo '{"msg":"setup_url","url":"http://localhost:1/#token=fake"}'`,
  ].join("\n"),
};

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function runInstall(env: NodeJS.ProcessEnv, port: number, papHome: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        DAEMON,
        "service",
        "install",
        "--port",
        String(port),
        "--home",
        papHome,
      ],
      { env, timeout: INSTALL_MS, maxBuffer: 1 << 20 },
      (error, stdout, stderr) =>
        error === null
          ? resolve(stdout)
          : reject(new Error(`pap service install failed: ${error.message}\n${stdout}${stderr}`)),
    );
  });
}

/** The unit's own command line and environment: no shell, no `%` specifiers (renderUnit allows none). */
function parseUnit(text: string): { exec: string[]; environment: Record<string, string> } {
  const exec = text.split("\n").find((line) => line.startsWith("ExecStart="));
  if (exec === undefined) throw new Error("the unit has no ExecStart=");
  const environment: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (!line.startsWith("Environment=")) continue;
    const pair = line.slice("Environment=".length);
    const at = pair.indexOf("=");
    environment[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return { exec: exec.slice("ExecStart=".length).split(" "), environment };
}

function checkLauncher(path: string, fakes: string, papHome: string, main: string): void {
  if ((statSync(path).mode & 0o777) !== 0o755) throw new Error(`${path} is not mode 0755`);
  execFileSync("sh", ["-n", path]);
  const text = readFileSync(path, "utf8");
  const exec = text.split("\n").find((line) => line.startsWith("exec '"));
  if (exec === undefined) throw new Error("the launcher has no exec line");
  // Swap the node of the exec line for a fake that prints what it receives.
  const fakeNode = join(fakes, "fake-node");
  writeExecutable(fakeNode, 'echo "home=$PAP_HOME"\nfor a in "$@"; do echo "arg=$a"; done');
  const swapped = join(fakes, "pap-launcher");
  writeExecutable(
    swapped,
    text.replace(/^#!\/bin\/sh\n/, "").replace(/^exec '[^']*'/m, `exec '${fakeNode}'`),
  );
  const run = spawnSync(swapped, ["one", "two words"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
  const expected = [
    `home=${papHome}`,
    "arg=--disable-warning=ExperimentalWarning",
    `arg=${main}`,
    "arg=one",
    "arg=two words",
  ].join("\n");
  if (run.status !== 0 || run.stdout.trim() !== expected)
    throw new Error(
      `the launcher forwarded ${JSON.stringify(run.stdout)}, expected ${JSON.stringify(expected)}`,
    );
}

function refused(host: string, port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error(`connecting to ${host}:${port} timed out instead of being refused`));
    });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", (error: NodeJS.ErrnoException) =>
      error.code === "ECONNREFUSED" ? resolve(true) : reject(error),
    );
  });
}

function setprivPath(): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(dir, "setpriv");
    if (dir !== "" && existsSync(candidate)) return candidate;
  }
  return null;
}

async function check(root: string, userHome: string, setup: { daemon: Daemon | null }): Promise<void> {
  const fakes = join(root, "fakes");
  const agent = join(root, "agent");
  const papHome = join(root, "pap-home");
  for (const dir of [fakes, agent]) mkdirSync(dir);
  for (const [name, body] of Object.entries(FAKES)) writeExecutable(join(fakes, name), body);
  const port = await freePort();

  // The fakes are on PATH for the install step only; the daemon below gets the unit's own PATH.
  const installEnv: NodeJS.ProcessEnv = {
    PATH: `${fakes}${delimiter}${process.env.PATH ?? ""}`,
    HOME: userHome,
    LANG: process.env.LANG,
  };
  await runInstall(installEnv, port, papHome);
  const unitPath = join(userHome, ".config/systemd/user/pap.service");
  const unit = parseUnit(readFileSync(unitPath, "utf8"));
  step(`pap service install wrote ${unitPath}`);

  checkLauncher(join(userHome, ".local/bin/pap"), fakes, papHome, DAEMON);
  step("the launcher is mode 0755, passes sh -n and forwards its arguments");

  const env: NodeJS.ProcessEnv = {
    ...unit.environment,
    HOME: userHome,
    LANG: process.env.LANG,
    PI_CODING_AGENT_DIR: agent,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    NODE_OPTIONS: `--import=${NETWORK_GUARD}`,
  };
  const setpriv = setprivPath();
  if (setpriv === null) step("setpriv not found: NoNewPrivileges=yes is not mirrored (skipped)");
  const launch =
    setpriv === null
      ? { file: unit.exec[0] ?? "", args: unit.exec.slice(1) }
      : { file: setpriv, args: ["--no-new-privs", "--", ...unit.exec] };
  const daemon = startDaemon(env, port, launch);
  setup.daemon = daemon;

  const listening = await within(
    daemon.line("listening"),
    STEP_MS,
    "the daemon to listen (boot of the unit's ExecStart)",
  );
  const setupUrl = new URL(
    String((await within(daemon.line("setup_url"), STEP_MS, "the setup address")).url),
  );
  if (!LOOPBACK.has(setupUrl.hostname) || Number(setupUrl.port) !== port)
    throw new Error(
      `the setup URL ${setupUrl.href} is not loopback on port ${port} (listening: ${JSON.stringify(listening)})`,
    );
  step(`the unit's ExecStart boots the built daemon: ${setupUrl.origin}`);

  const page = await http(`http://127.0.0.1:${port}/`);
  if (page.status !== 200 || page.body !== readFileSync(WEB_INDEX, "utf8"))
    throw new Error(`GET / gave ${page.status}, expected 200 with apps/web/dist/index.html`);
  step("GET / answers 200 with the web index.html");

  const external = Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry !== undefined && entry.family === "IPv4" && !entry.internal);
  if (external === undefined) step("no non-loopback IPv4 address on this host: exposure check skipped");
  else if (await refused(external.address, port))
    step(`${external.address}:${port} refuses connections (loopback only)`);
  else throw new Error(`the daemon answers on ${external.address}:${port}, a non-loopback address`);

  const mode = (path: string): string => (statSync(path).mode & 0o777).toString(8);
  if (mode(papHome) !== "700") throw new Error(`${papHome} is mode ${mode(papHome)}, expected 700`);
  if (mode(join(papHome, "state.db")) !== "600")
    throw new Error(`state.db is mode ${mode(join(papHome, "state.db"))}, expected 600`);
  step("PAP_HOME is mode 0700 and state.db 0600");

  daemon.child.kill("SIGTERM");
  const exit = await within(daemon.exited, STOP_DEADLINE_MS, "the daemon to stop on SIGTERM");
  if (exit.code !== 0) throw new Error(`the daemon exited with ${JSON.stringify(exit)}, expected code 0`);
  step("SIGTERM: exit 0");
}

async function main(): Promise<void> {
  if (process.platform !== "linux") throw new Error("the install smoke test runs on Linux only");
  for (const [what, path] of [
    ["the daemon build", DAEMON],
    ["the web build", WEB_INDEX],
  ] as const)
    if (!existsSync(path)) throw new Error(`${what} is missing (${path}): run pnpm build first`);
  const setup: { daemon: Daemon | null } = { daemon: null };
  let root: string | null = null;
  const cleanup = (): void => {
    const pid = setup.daemon?.child.pid;
    if (pid !== undefined && pid > 1) {
      try {
        process.kill(-pid, "SIGKILL"); // only the group this run spawned
      } catch {
        // already gone
      }
    }
    if (root) rmSync(root, { recursive: true, force: true });
  };
  // Ctrl-C or a kill must not leave the detached daemon or the temporary root behind.
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)
    process.once(signal, () => {
      cleanup();
      process.exit(code);
    });
  try {
    root = mkdtempSync(join(tmpdir(), "pap-smoke-install-"));
    const userHome = join(root, "user");
    mkdirSync(userHome);
    await check(root, userHome, setup);
  } catch (error) {
    console.error(`smoke-install: ${error instanceof Error ? error.message : String(error)}`);
    if (setup.daemon)
      console.error(`smoke-install: daemon output:\n${setup.daemon.output.slice(-40).join("\n")}`);
    process.exitCode = 1;
  } finally {
    cleanup();
  }
  if (process.exitCode === undefined) step("install smoke: ok");
}

main().catch((error: unknown) => {
  console.error(`smoke-install: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
