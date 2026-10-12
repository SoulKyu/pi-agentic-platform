import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createSystemClock } from "../../../kernel/clock.ts";
import { silentLogger } from "../../../kernel/logger.ts";
import { probeScopes, type ScopeLimits, type WorkerScopes } from "../../../kernel/supervisor/scope.ts";
import { execFileCode, execFileText, whichOnPath } from "../../../kernel/which.ts";

// A clean environment (`env -i`, a CI step) has no XDG_RUNTIME_DIR; the user manager's socket is where logind puts it.
const runtimeDir = `/run/user/${process.getuid?.() ?? -1}`;
if (!process.env.XDG_RUNTIME_DIR && existsSync(runtimeDir)) process.env.XDG_RUNTIME_DIR = runtimeDir;

const available = (() => {
  try {
    const linger = execFileSync(
      "loginctl",
      ["show-user", String(process.getuid?.() ?? -1), "--property=Linger", "--value"],
      { encoding: "utf8", timeout: 5000 },
    ).trim();
    execFileSync("systemd-run", ["--user", "--scope", "--quiet", "--collect", "--", "true"], {
      stdio: "ignore",
      timeout: 5000,
    });
    return linger === "yes";
  } catch {
    return false;
  }
})();
// Containment, not a security probe: skipped locally with a printed reason, but CI starts a user manager and must run it (M2R31, M2R114).
if (!available && process.env.CI)
  throw new Error("real-scopes: CI must provide a lingering systemd user manager (see ci.yml)");
if (!available)
  console.warn("real-scopes: OOM cases skipped: no lingering systemd user manager answers here");

export const scopesAvailable = available;

const probed: WorkerScopes[] = [];

/** Task 5's probe on a home of the test's own: its slice is never the owner's daemon slice. */
export async function realScopes(limits: ScopeLimits): Promise<WorkerScopes> {
  const scopes = await probeScopes("auto", limits, {
    home: `/nonexistent/pap-int-scopes-${process.pid}`,
    uid: process.getuid?.() ?? -1,
    exec: execFileText,
    execSync: execFileCode,
    env: process.env,
    which: (command) => whichOnPath(command, process.env),
    clock: createSystemClock(),
    logger: silentLogger,
  });
  if (!scopes.enabled) throw new Error("real-scopes: the probe found no usable user manager");
  probed.push(scopes);
  return scopes;
}

/** Stops every slice `realScopes` made, then lists the units of those slices still loaded (an empty list when clean). */
export async function releaseScopes(): Promise<string[]> {
  const leftovers: string[] = [];
  for (const scopes of probed.splice(0)) {
    await scopes.sweep();
    scopes.killAllNow();
    const hash = /^app-pap-([0-9a-f]{8})\.slice$/.exec(scopes.slice ?? "")?.[1];
    if (!hash) throw new Error(`real-scopes: unexpected slice name ${scopes.slice}`);
    const listed = execFileSync(
      "systemctl",
      ["--user", "list-units", "--all", "--plain", "--no-legend", `*pap-${hash}*`],
      { encoding: "utf8", timeout: 5000 },
    );
    leftovers.push(...listed.split("\n").filter((line) => line.trim() !== ""));
  }
  return leftovers;
}
