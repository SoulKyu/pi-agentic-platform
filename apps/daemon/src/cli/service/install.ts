import { execFile } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { CliError, type CliIo } from "../open-home.ts";
import type { Command } from "../run-cli.ts";
import { UsageError } from "../usage.ts";
import { JOURNAL_HINT, UNIT, UNVERIFIED_EXIT, unitFilePath, waitWithLoopHeld, withHint } from "./common.ts";
import { renderLauncher, writeLauncher } from "./launcher.ts";
import { waitForListening } from "./readiness.ts";
import { createSystemd, type Systemd } from "./systemd.ts";
import { renderUnit, safePath, unitStopTimeoutSec } from "./unit.ts";

const DEFAULT_PORT = 7777;

/** The flag name only: a refused path is never echoed back. */
function checked(flag: string, value: string): string {
  try {
    return safePath(flag, value);
  } catch {
    throw new CliError(`${flag} must be an absolute path of letters, digits and . _ + @ / - only`);
  }
}

function nodeVersionOk(node: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(node, ["--version"], { timeout: 5000, env: {}, maxBuffer: 1024 }, (error, stdout) => {
      const match = error === null ? /^v24\.(\d+)\./.exec(stdout.trim()) : null;
      resolve(match !== null && Number(match[1]) >= 14);
    });
  });
}

async function checkRuntime(node: string, main: string): Promise<void> {
  try {
    if (!statSync(main).isFile()) throw new Error("not a file");
  } catch {
    throw new CliError("--main is not a file");
  }
  try {
    if (!statSync(node).isFile()) throw new Error("not a file");
    accessSync(node, constants.X_OK);
  } catch {
    throw new CliError("--node is not an executable file");
  }
  if (!(await nodeVersionOk(node))) throw new CliError("--node must be Node 24.14 or newer");
}

function writeUnitFile(target: string, text: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}`;
  try {
    writeFileSync(temp, text, { flag: "wx", mode: 0o644 });
    chmodSync(temp, 0o644);
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

async function ensureLinger(systemd: Systemd, io: CliIo): Promise<void> {
  const uid = process.getuid?.();
  if (uid === undefined) throw new CliError("pap service needs a Linux user session");
  // A missing loginctl is the same as linger being off: warn with the command, do not abort the install.
  const lingerOn = async (): Promise<boolean> => {
    try {
      return await systemd.lingerEnabled(uid);
    } catch (error) {
      if (error instanceof CliError) return false;
      throw error;
    }
  };
  if (await lingerOn()) return;
  await systemd.enableLinger();
  if (await lingerOn()) return;
  io.stderr.write(
    `pap: warning: linger is off, so pap stops when you log out and worker scopes are unavailable; run: loginctl enable-linger ${userInfo().username}\n`,
  );
}

function resolveMain(given: string | undefined): string {
  if (given !== undefined) return given;
  try {
    return realpathSync(process.argv[1] ?? "");
  } catch {
    throw new CliError("cannot locate the pap entry point; pass --main <abs>");
  }
}

function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const port = /^\d{1,5}$/.test(raw) ? Number(raw) : 0;
  if (port < 1 || port > 65_535) throw new UsageError("--port must be an integer from 1 to 65535");
  return port;
}

export const serviceInstall: Command = {
  options: {
    node: { type: "string" },
    main: { type: "string" },
    port: { type: "string" },
    home: { type: "string" },
    "bin-dir": { type: "string" },
  },
  async run({ values, positionals, io }) {
    if (positionals.length > 0) throw new UsageError("service install takes no argument");
    const str = (name: string): string | undefined =>
      typeof values[name] === "string" ? values[name] : undefined;
    const port = parsePort(str("port"));
    const node = checked("--node", str("node") ?? process.execPath);
    const main = checked("--main", resolveMain(str("main")));
    const homeFlag = str("home");
    if (homeFlag === undefined && io.env.PAP_HOME)
      io.stderr.write(
        "pap: warning: PAP_HOME is set but the service ignores it (the unit has no PAP_HOME without --home, so data goes to ~/.pap); pass --home to use it\n",
      );
    const home = homeFlag === undefined ? undefined : checked("--home", homeFlag);
    const binDir = checked("--bin-dir", str("bin-dir") ?? join(io.homedir, ".local", "bin"));
    await checkRuntime(node, main);

    const systemd = createSystemd(io.env);
    if (!(await systemd.userManagerUp()))
      throw new CliError(
        "no systemd user manager: log in with a full session or set XDG_RUNTIME_DIR=/run/user/<uid>",
      );
    await ensureLinger(systemd, io);

    const unitText = renderUnit({
      node,
      main,
      stopTimeoutSec: unitStopTimeoutSec(),
      ...(port === undefined ? {} : { port }),
      ...(home === undefined ? {} : { home }),
    });
    const unitPath = unitFilePath(io);
    writeUnitFile(unitPath, unitText);
    const launcherResult = writeLauncher(
      binDir,
      renderLauncher({ node, main, ...(home === undefined ? {} : { home }) }),
    );
    if (launcherResult === "foreign")
      io.stderr.write(`pap: warning: ${join(binDir, "pap")} is not ours and was left alone\n`);

    let wasEnabled = false;
    let wasActive = false;
    let since = new Date(io.clock.now());
    const ready = await withHint(async () => {
      await systemd.daemonReload();
      wasEnabled = await systemd.isEnabled(UNIT); // a unit file left by an abandoned first install is not a working install
      await systemd.enable(UNIT);
      wasActive = await systemd.isActive(UNIT);
      since = new Date(io.clock.now());
      await systemd.resetFailed(UNIT); // the start limit counts manual starts: a retry within 120 s would be refused
      await systemd.restart(UNIT);
      return waitWithLoopHeld(() =>
        waitForListening(
          { systemd, sleep: (ms) => io.clock.sleep(ms), now: () => new Date(io.clock.now()) },
          UNIT,
          since,
          port ?? DEFAULT_PORT,
        ),
      );
    });
    if (ready.kind === "unreadable")
      throw new CliError(
        "installed, but the user journal is not readable (a volatile journal?), so pap's start could not be checked; pap may be running: systemctl --user status pap (docs/agents/install.md, Prerequisites)",
        UNVERIFIED_EXIT,
      );
    if (ready.kind === "never") {
      if (!wasEnabled)
        await abandonFirstInstall(
          systemd,
          io,
          unitPath,
          launcherResult === "written" ? join(binDir, "pap") : null,
        );
      throw new CliError(`pap did not start listening; see: ${JOURNAL_HINT}`);
    }

    const listen = `http://localhost:${port ?? DEFAULT_PORT}`;
    const onPath = (io.env.PATH ?? "").split(delimiter).includes(binDir);
    const lines = [
      `service installed: ${unitPath}`,
      `listening on ${listen} (this machine only)`,
      ready.kind === "url"
        ? `setup (one time, open it in your browser): ${ready.url}`
        : `an owner already exists: open ${listen} (see also: pap service url)`,
      ...(ready.kind === "url"
        ? ["the one-time setup URL also stays in your user journal until it is used"]
        : []),
      `remote host: ssh -L ${port ?? DEFAULT_PORT}:localhost:${port ?? DEFAULT_PORT} <you>@<host>, then open ${listen}`,
      `data stays in ${home ?? "~/.pap"}; uninstall with: pap service uninstall (your data is not deleted)`,
      ...launcherLines(launcherResult, binDir, onPath, node, main),
      ...(wasActive ? ["pap was running and has been restarted; running turns were interrupted"] : []),
    ];
    io.stdout.write(`${lines.join("\n")}\n`);
    return 0;
  },
};

const shellQuote = (path: string): string => `'${path.replaceAll("'", "'\\''")}'`;

/** A first install that never listens has no working unit to fall back to: stop it, keep it from starting again, say what is left. */
async function abandonFirstInstall(
  systemd: Systemd,
  io: CliIo,
  unitPath: string,
  launcherPath: string | null,
): Promise<void> {
  const quietly = (step: Promise<void>): Promise<boolean> =>
    step.then(
      () => true,
      () => false,
    );
  await quietly(systemd.stop(UNIT)); // a live but silent daemon must not outlive the files it runs from
  const disabled = await quietly(systemd.disable(UNIT));
  const files = [unitPath, ...(launcherPath === null ? [] : [launcherPath])].map(shellQuote);
  io.stderr.write(
    [
      `pap: warning: the first install did not start, so pap.service was stopped and ${disabled ? "disabled (it will not start at boot (with linger) or at login)" : "could not be disabled: run systemctl --user disable pap.service"}.`,
      `Left behind: ${files.join(" ")}`,
      `To remove them: systemctl --user stop pap.service; rm ${files.join(" ")}; systemctl --user daemon-reload`,
      "",
    ].join("\n"),
  );
}

function launcherLines(
  result: "written" | "foreign",
  binDir: string,
  onPath: boolean,
  node: string,
  main: string,
): string[] {
  if (result === "foreign")
    return [
      `${join(binDir, "pap")} is a different file and was left alone; run pap with: '${node}' --disable-warning=ExperimentalWarning '${main}'`,
    ];
  return [
    `\`pap\` command: ${join(binDir, "pap")}`,
    ...(onPath
      ? []
      : [
          `${binDir} is not on your PATH; use the full path above or add it yourself (this installer edits no shell file)`,
        ]),
  ];
}
