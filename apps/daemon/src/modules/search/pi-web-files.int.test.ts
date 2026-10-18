import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSystemClock } from "../../kernel/clock.ts";
import { createLogger } from "../../kernel/logger.ts";
import { startTestDaemon, type TestDaemon } from "../../testing/harness.ts";

/** Spec D rule 4: pap and pi-web share `~/.pi/agent`, and pap never reads the files pi-web keeps there. */
const UNIQUE = "flamingoquartzmarker";
const LOG_LINES: string[] = [];
let t: TestDaemon;
let root = "";
let secret = "";

/** A Pi session file a reader would index (valid header, dated after the install, `UNIQUE` in a message). */
function sessionText(cwd: string): string {
  const timestamp = new Date(Date.now() + 3_600_000).toISOString();
  const header = { type: "session", version: 3, id: randomUUID(), timestamp, cwd };
  const entry = {
    type: "message",
    id: "a1b2c3d4",
    parentId: null,
    timestamp,
    message: { role: "user", content: `about ${UNIQUE}`, timestamp: Date.parse(timestamp) },
  };
  return `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`;
}

/** pi-web's files and the `sessions/` look-alikes, all on disk before the scanner starts. */
function piWebFiles(cwd: string): Record<string, string> {
  const lookAlike = sessionText(cwd);
  return {
    "pi-web-session-a.json": JSON.stringify({ id: randomUUID(), note: UNIQUE, cwd }),
    "agent-ops/task.json": JSON.stringify({ task: UNIQUE }),
    "agent-ops/sessions/s.jsonl": lookAlike,
    "agent-ops/direct.jsonl": lookAlike,
    "agent-spaces/x/notes.md": `# ${UNIQUE}\n`,
    "agent-spaces/x/sessions/s.jsonl": lookAlike,
    "agents-home/y/MEMORY.md": `${UNIQUE}\n`,
    "agents-home/y/sessions/s.jsonl": lookAlike,
    "agents-secrets/z.json": JSON.stringify({ key: UNIQUE }),
    "agents-secrets/sessions/s.jsonl": lookAlike,
  };
}

beforeEach(async () => {
  LOG_LINES.length = 0;
  const logger = createLogger({
    level: "debug",
    clock: createSystemClock(),
    write: (line) => LOG_LINES.push(line),
  });
  root = mkdtempSync(join(tmpdir(), "pap-int-"));
  for (const [relative, text] of Object.entries(piWebFiles(join(root, "work")))) {
    const path = join(root, "agent", relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  secret = join(root, "agent", "agents-secrets", "z.json");
  chmodSync(secret, 0);
  t = await startTestDaemon({ steps: [] }, { deps: { logger }, root });
  vi.stubEnv("PI_CODING_AGENT_DIR", join(t.root, "agent"));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  // The mode-000 file would stop the temporary folder from being removed.
  chmodSync(secret, 0o600);
  await t.stop();
  rmSync(root, { recursive: true, force: true });
});

const kindOf = (frame: { event: unknown }) => (frame.event as { kind?: string }).kind;

it("ignores pi-web's own files in the shared Pi folder and the sessions look-alikes inside them", async () => {
  const client = await t.connect(await t.login());
  await client.call("subscribe.shell", {});
  await client.waitForEvent((frame) => kindOf(frame) === "snapshot", 10_000);

  // Pi's own session after them: its event proves the scanner ran, and anything it read of the others came first.
  const manager = SessionManager.create(t.cwd, join(t.root, "agent", "sessions", "--pap-sentinel--"));
  manager.appendMessage({ role: "user", content: "a sentinel about kubernetes", timestamp: Date.now() });
  const event = await client.waitForEvent((frame) => kindOf(frame) === "session", 30_000);
  const sentinel = (event.event as { session: { id: string; preview: string } }).session;
  expect(sentinel.preview).toBe("a sentinel about kubernetes");
  await vi.waitFor(
    async () => {
      const answer = await client.call("search.query", { q: "kubernetes sentinel" });
      expect((answer as unknown as { result: { hits: unknown[] } }).result.hits).toHaveLength(1);
    },
    { timeout: 10_000 },
  );

  const sessionIds = new Set(
    client.events
      .filter((frame) => kindOf(frame) === "session")
      .map((frame) => (frame.event as { session: { id: string } }).session.id),
  );
  expect([...sessionIds]).toEqual([sentinel.id]);
  const answer = await client.call("search.query", { q: UNIQUE });
  expect((answer as unknown as { result: { hits: unknown[] } }).result.hits).toEqual([]);
  // The index never opened a file outside `sessions/`: not even to mark it bad or excluded.
  const index = new DatabaseSync(join(t.home, "search.db"), { readOnly: true });
  try {
    const paths = (index.prepare("SELECT path FROM files").all() as Array<{ path: string }>).map(
      (row) => row.path,
    );
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(path.startsWith(join(t.root, "agent", "sessions") + "/")).toBe(true);
  } finally {
    index.close();
  }
  const log = LOG_LINES.join("");
  expect(LOG_LINES.some((line) => line.includes('"level":"error"'))).toBe(false);
  // The scanner says a file it could not read (the mode-000 one) as a warning: there must be none.
  expect(
    LOG_LINES.filter((line) => line.includes('"module":"search"') && line.includes('"level":"warn"')),
  ).toEqual([]);
  for (const name of [
    "pi-web-session-a",
    "agent-ops",
    "agent-spaces",
    "agents-home",
    "agents-secrets",
    UNIQUE,
  ]) {
    expect(log).not.toContain(name);
  }
});
