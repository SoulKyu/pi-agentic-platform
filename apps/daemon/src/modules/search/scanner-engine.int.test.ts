import { mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { createIntBed, promptAndSettle } from "../sessions/testing/int-bed.ts";
import { openSearchIndex } from "./index-db.ts";
import { createSearchIndexStore } from "./index-store.ts";
import { createScanEngine } from "./scanner-engine.ts";
import { fakeWatch } from "./testing/fake-watch.ts";

it("indexes a session pap launched under that session when the agent folder is reached through a link", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "pap-engine-int-"));
  const bed = await createIntBed(
    { steps: [{ text: "a scripted answer" }] },
    {
      // The daemon is told the agent folder through a link: Pi reports that spelling, not the real path.
      spellAgentDir: (agentDir) => {
        const link = join(dirname(agentDir), "agent-link");
        symlinkSync(agentDir, link);
        return link;
      },
    },
  );
  const db = openSearchIndex(join(scratch, "search.db"), silentLogger);
  try {
    const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
    const live = await bed.subscribe(sessionId);
    await promptAndSettle(bed, live, sessionId, "hello");

    const linked = join(dirname(bed.agentDir), "agent-link", "sessions");
    const [folderName] = readdirSync(linked);
    const [fileName] = readdirSync(join(linked, folderName ?? ""));
    const file = join(linked, folderName ?? "", fileName ?? "");
    const store = createSearchIndexStore(db);
    const clock = createFakeClock();
    const watch = fakeWatch();
    const say = vi.fn();
    const engine = createScanEngine({
      root: linked,
      ctx: { installedAt: 0, store, sessions: bed.sessions.scanPort, logger: silentLogger, say },
      watch: watch.factory,
      clock,
      logger: silentLogger,
      say,
      requestReconcile: () => undefined,
      onDamaged: () => undefined,
    });
    try {
      engine.watchRoot();
      watch.emit(linked, folderName ?? "");
      watch.emit(join(linked, folderName ?? ""), fileName ?? "");
      await clock.advance(250);
      await engine.idle();
      expect(store.cursor(file)).toMatchObject({ state: "indexed", sessionId });
      expect(say).not.toHaveBeenCalledWith("session_file_duplicate_id", expect.anything());
    } finally {
      await engine.close();
    }
  } finally {
    db.close();
    await bed.dispose();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 60_000);
