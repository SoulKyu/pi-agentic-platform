// The smoke's scanner and search step: a Pi session file written by hand, as the pi CLI writes one, under the smoke's
// temporary agent folder must reach the `shell` stream, and the smoke session's own reply must be found by search. The
// search worker thread's `.js` entry exists only in the build (M4R53), so only the built daemon proves it.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { asJson, type Json, type SmokeSocket, step, within } from "./smoke-lib.ts";

const SESSION_WAIT_MS = 10_000;
const SEARCH_WAIT_MS = 10_000;
const POLL_MS = 100;
const MARKER = "pap-smoke-ok";

export interface ScannerAndSearchContext {
  /** The smoke's `PI_CODING_AGENT_DIR`. */
  readonly agentDir: string;
  /** The folder of the smoke session that already ran the scripted prompt. */
  readonly cwd: string;
  readonly socket: SmokeSocket;
}

const sessionOf = (event: Json): Json => asJson(event.session);

/** Pi's folder for a working directory: `--<path with separators as ->--` (the CLI's naming). */
function piFolder(agentDir: string, cwd: string): string {
  return join(agentDir, "sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
}

/** A header and one user line, the format the CLI writes, dated now (after the daemon's install time). */
function writeCliSession(agentDir: string, cwd: string): string {
  const folder = piFolder(agentDir, cwd);
  mkdirSync(folder, { recursive: true });
  const id = randomUUID();
  const now = new Date();
  const header = { type: "session", version: 3, id, timestamp: now.toISOString(), cwd };
  const entry = {
    type: "message",
    id: "a1b2c3d4",
    parentId: null,
    timestamp: now.toISOString(),
    message: { role: "user", content: "a note typed in the pi cli", timestamp: now.getTime() },
  };
  writeFileSync(
    join(folder, `${now.toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`),
    `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`,
  );
  return id;
}

async function searchUntilFound(socket: SmokeSocket, cwd: string): Promise<void> {
  const deadline = Date.now() + SEARCH_WAIT_MS;
  for (;;) {
    const hits = asJson(await socket.call("search.query", { q: MARKER })).hits;
    const found = Array.isArray(hits) && hits.some((hit) => asJson(asJson(hit).session).cwd === cwd);
    if (found) return;
    if (Date.now() > deadline)
      throw new Error(`search found no hit of the smoke session for ${MARKER}: ${JSON.stringify(hits)}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** Run after the agent's reply has settled. The session of `cwd` is the one whose reply holds the marker. */
export async function checkScannerAndSearch(ctx: ScannerAndSearchContext): Promise<void> {
  const cliCwd = join(ctx.cwd, "cli");
  mkdirSync(cliCwd);
  await ctx.socket.call("subscribe.shell", {});
  await ctx.socket.waitFor((event) => event.kind === "snapshot", "the shell snapshot");
  const id = writeCliSession(ctx.agentDir, cliCwd);
  await within(
    ctx.socket.waitFor(
      (candidate) => candidate.kind === "session" && sessionOf(candidate).cwd === cliCwd,
      `the CLI session ${id} on the shell stream`,
    ),
    SESSION_WAIT_MS,
    `the CLI session ${id} on the shell stream`,
  );
  await searchUntilFound(ctx.socket, ctx.cwd);
  step("a CLI session reached the sidebar; search found the smoke session");
}
