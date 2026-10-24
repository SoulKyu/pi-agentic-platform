import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import type { LiveSession } from "./live-session.ts";
import { createStoreSync } from "./service-sync.ts";
import type { SessionRow } from "./store.ts";

const AGENT = "atlas-1a2b";
let root: string;
afterEach(() => rmSync(root, { recursive: true, force: true }));

function setup() {
  root = mkdtempSync(join(tmpdir(), "pap-sync-"));
  const papHome = join(root, "pap");
  const agentDir = join(root, "pi");
  mkdirSync(join(papHome, "agents", ".mirrors", AGENT), { recursive: true });
  mkdirSync(join(papHome, "agents", ".mirrors", "other-9z9z"), { recursive: true });
  mkdirSync(join(agentDir, "sessions"), { recursive: true });
  const bound: Array<[string, string, string]> = [];
  const log = captureLogger();
  const sync = createStoreSync({
    store: {
      bindPiFile: (...args: [string, string, string]) => (bound.push(args), true),
      marks: { row: () => undefined },
    } as never,
    clock: createFakeClock(),
    logger: log.logger,
    hub: { publish: vi.fn() },
    agentDir,
    papHome,
    onPolicyRecord: () => {},
    onTaint: () => {},
  });
  const file = (path: string) => {
    writeFileSync(path, "x\n");
    return path;
  };
  const session = (path: string) =>
    ({ piFile: () => path, piSessionId: () => "pi-1" }) as unknown as LiveSession;
  return { papHome, agentDir, bound, sync, log, file, session };
}
const row = (extra: Partial<SessionRow> = {}): SessionRow =>
  ({ id: "s1", ownerId: "u1", agentId: AGENT, agentRole: "thread", piPath: null, ...extra }) as SessionRow;

describe("bindPiFile accepts a VM row's mirror (T9b)", () => {
  it("binds the mirror of the row's own agent", () => {
    const t = setup();
    const path = t.file(join(t.papHome, "agents", ".mirrors", AGENT, "s.jsonl"));
    expect(t.sync.bindPiFile(row(), t.session(path))).toBe(true);
    expect(t.bound).toEqual([["s1", path, "pi-1"]]);
  });

  it("still binds a file under Pi's sessions folder", () => {
    const t = setup();
    const path = t.file(join(t.agentDir, "sessions", "s.jsonl"));
    expect(t.sync.bindPiFile(row({ agentId: undefined, agentRole: undefined }), t.session(path))).toBe(true);
    expect(t.bound).toHaveLength(1);
  });

  it.each([
    [
      "another agent's mirror",
      (t: ReturnType<typeof setup>) => join(t.papHome, "agents", ".mirrors", "other-9z9z", "s.jsonl"),
      {},
    ],
    [
      "a mirror for a host row",
      (t: ReturnType<typeof setup>) => join(t.papHome, "agents", ".mirrors", AGENT, "s.jsonl"),
      { agentId: undefined, agentRole: undefined },
    ],
    [
      "a nested path in the mirror folder",
      (t: ReturnType<typeof setup>) => join(t.papHome, "agents", ".mirrors", AGENT, "d", "s.jsonl"),
      {},
    ],
    ["a file elsewhere", (t: ReturnType<typeof setup>) => join(t.papHome, "agents", "s.jsonl"), {}],
  ])("refuses %s", (_name, pathOf, extra) => {
    const t = setup();
    mkdirSync(join(t.papHome, "agents", ".mirrors", AGENT, "d"), { recursive: true });
    const path = t.file(pathOf(t));
    expect(t.sync.bindPiFile(row(extra as Partial<SessionRow>), t.session(path))).toBe(true);
    expect(t.bound).toEqual([]);
    expect(t.log.lines.filter((line) => line.msg === "session_file_refused")).toHaveLength(1);
  });
});
