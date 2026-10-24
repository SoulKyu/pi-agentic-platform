import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ShellSession } from "@pap/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSystemClock } from "../../kernel/clock.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { testCaller } from "../../testing/caller.ts";
import type { SessionsScanPort } from "../sessions/index.ts";
import { createSearchModule } from "./index.ts";
import { processFile } from "./scanner-file.ts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pap-search-mirrors-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const ctx = {
  caller: testCaller(),
  connectionId: "c",
  openSubscription: vi.fn(),
  closeSubscription: vi.fn(),
};
const summaryOf = (id: string): ShellSession => ({
  id,
  cwd: "/w",
  name: null,
  preview: null,
  status: "idle",
  toolPreset: "configured",
  needsInput: false,
  projectId: null,
  pinRank: null,
  archivedAt: null,
  settledAt: null,
  snoozedUntil: null,
  createdAt: 1,
  updatedAt: 2,
});

/** The sessions port as it answers for mirrors: the row that holds the path claims it, any other file is skipped. */
const portFor = (known: ReadonlyMap<string, string>): SessionsScanPort => ({
  claim: (path) => {
    const sessionId = known.get(path);
    return sessionId === undefined
      ? { kind: "skip", reason: "not_pi_file" }
      : { kind: "session", sessionId, ownerId: "u1" };
  },
  touched: () => {},
  named: () => {},
  previewed: () => {},
  summary: (id) => summaryOf(id),
});

it("finds a message of an agent mirror", async () => {
  const folder = join(home, "agents", ".mirrors", "agent-1");
  mkdirSync(folder, { recursive: true });
  const path = join(folder, "vm.jsonl");
  const now = new Date().toISOString();
  const lines = [
    { type: "session", id: "pi-vm1", cwd: "/w", timestamp: now },
    {
      type: "message",
      id: "e1",
      timestamp: now,
      message: { role: "user", content: "rotate the zebrafish credentials" },
    },
  ];
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  let indexed!: () => void;
  const processed = new Promise<void>((resolve) => (indexed = resolve));
  const module = createSearchModule({
    home,
    agentDir: join(home, "pi-agent"),
    installedAt: 0,
    readOnly: false,
    clock: createSystemClock(),
    logger: silentLogger,
    sessions: portFor(new Map([[path, "vm-session"]])),
    process: (file, scan) => {
      const outcome = processFile(file, scan);
      if (file === path && outcome.kind === "indexed") indexed();
      return outcome;
    },
  });
  try {
    module.start();
    await processed;
    const { hits } = await module.rpc["search.query"]({ q: "zebrafish" }, ctx);
    expect(hits.map((hit) => hit.sessionId)).toEqual(["vm-session"]);
  } finally {
    await module.stop();
  }
}, 30_000);
