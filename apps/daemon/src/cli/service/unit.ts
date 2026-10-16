import { dirname } from "node:path";
import { STOP_DEADLINE_MS } from "../../shutdown.ts";

/** Absolute, no `..` segment, only characters that mean nothing to systemd (no space, quote, `%`, `$`, `\`, `;`). */
const SAFE_PATH = /^\/[A-Za-z0-9._+@/-]{0,1022}[A-Za-z0-9._+@-]$/;

export class UnitInputError extends Error {
  override name = "UnitInputError";
}

export function safePath(label: string, value: string): string {
  if (
    !SAFE_PATH.test(value) ||
    value.split("/").some((part) => part === ".." || part === ".") ||
    value.includes("//")
  )
    throw new UnitInputError(
      `${label} must be an absolute path of letters, digits and . _ + @ / - only (got ${JSON.stringify(value.slice(0, 80))})`,
    );
  return value;
}

export interface UnitInput {
  readonly node: string;
  readonly main: string;
  readonly port?: number;
  readonly home?: string;
  readonly stopTimeoutSec: number;
}

export function renderUnit(input: UnitInput): string {
  const node = safePath("--node", input.node);
  const main = safePath("--main", input.main);
  if (input.port !== undefined && !(Number.isInteger(input.port) && input.port >= 1 && input.port <= 65_535))
    throw new UnitInputError("--port must be an integer from 1 to 65535");
  if (!Number.isInteger(input.stopTimeoutSec) || input.stopTimeoutSec < 1 || input.stopTimeoutSec > 3600)
    throw new UnitInputError("stopTimeoutSec must be an integer from 1 to 3600");
  const path = [...new Set([dirname(node), "/usr/local/bin", "/usr/bin", "/bin"])].join(":");
  const exec = [node, "--disable-warning=ExperimentalWarning", main, "serve"];
  if (input.port !== undefined) exec.push("--port", String(input.port));
  return [
    "[Unit]",
    "Description=pap (self-hosted agentic platform)",
    "StartLimitIntervalSec=120",
    "StartLimitBurst=5",
    "",
    "[Service]",
    `ExecStart=${exec.join(" ")}`,
    `Environment=PATH=${path}`,
    ...(input.home === undefined ? [] : [`Environment=PAP_HOME=${safePath("--home", input.home)}`]),
    "NoNewPrivileges=yes",
    "RestrictSUIDSGID=yes",
    "LockPersonality=yes",
    "Restart=on-failure",
    "RestartSec=5",
    "KillMode=mixed",
    `TimeoutStopSec=${input.stopTimeoutSec}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export interface JournalFacts {
  readonly listening: boolean;
  readonly setupUrl: string | null;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
/**
 * One pass over the journal text of one start: did the daemon log `listening`, and what is its last loopback setup_url
 * (of `port` when given: a URL of another port belongs to another install).
 */
export function readJournal(journal: string, port?: number): JournalFacts {
  let listening = false;
  let setupUrl: string | null = null;
  for (const line of journal.split("\n")) {
    const wantsListening = line.includes('"listening"');
    if (!wantsListening && !line.includes('"setup_url"')) continue;
    try {
      const entry = JSON.parse(line) as { msg?: unknown; url?: unknown };
      if (entry.msg === "listening") listening = true;
      if (entry.msg !== "setup_url" || typeof entry.url !== "string" || entry.url.length > 2048) continue;
      const url = new URL(entry.url);
      if (
        url.protocol === "http:" &&
        LOOPBACK.has(url.hostname) &&
        (port === undefined || Number(url.port || 80) === port)
      )
        setupUrl = url.href;
    } catch {
      /* a torn or foreign line */
    }
  }
  return { listening, setupUrl };
}

/** systemd waits this long before SIGKILL: longer than the daemon's own graceful stop (M6R4). */
export const unitStopTimeoutSec = (): number => Math.ceil(STOP_DEADLINE_MS / 1000) + 10;
