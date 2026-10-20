import { EventEmitter } from "node:events";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureLogger } from "../../testing/capture-logger.ts";
import { startTestDaemon, type TestDaemon } from "../../testing/harness.ts";
import { startVmBed, type VmBed } from "../../testing/vm-bed.ts";
import { openOwner, rows, type Owner } from "../../security/testing/automation-bed.ts";
import type { RelayChild } from "./relay-link.ts";

/*
 * AVM-P17, AVM-E2, RT-46 through a whole daemon: the two Claude-token methods are real in host and vm modes. Mutants (RT-43),
 * each run for real: the handlers dropped from `daemon.ts` (the stub answers sandbox_unavailable) -> both cases fail; the
 * store's listener not registered in vm mode -> "pushes it to the relay" fails; the value in a log line -> "no log line".
 */
const TOKEN = "sk-ant-oat01-OWNER-SETUP-TOKEN-0123456789";
let t: TestDaemon | undefined;
let owner: Owner | undefined;
let bed: VmBed | undefined;
afterEach(async () => {
  owner?.client.close();
  await t?.stop();
  await bed?.stop();
  t = undefined;
  owner = undefined;
  bed = undefined;
});

describe("the Claude token methods", () => {
  it("store and remove the token in host mode, 0600 in a 0700 folder, and answer no value", async () => {
    const { logger, lines } = captureLogger();
    t = await startTestDaemon({ steps: [{ text: "ok" }] }, { deps: { logger } });
    owner = await openOwner(t);
    const file = join(t.home, "secrets", "claude-token");
    const set = await owner.client.call("agents.vm.setClaudeToken", { token: TOKEN });
    expect(set).toMatchObject({ ok: true, result: { ok: true } });
    expect(JSON.stringify(set).includes(TOKEN)).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(TOKEN);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(t.home, "secrets")).mode & 0o777).toBe(0o700);
    expect(await owner.client.call("agents.vm.clearClaudeToken", {})).toMatchObject({ ok: true });
    expect(existsSync(file)).toBe(false);
    // M7: both changes are in the audit, without the value.
    const audited = rows<{ reason: string; kind: string; detail: string | null }>(
      t.home,
      "SELECT reason, kind, detail FROM audit WHERE reason LIKE 'claude_token_%' ORDER BY id",
    );
    expect(audited.map((row) => [row.kind, row.reason])).toEqual([
      ["auth", "claude_token_set"],
      ["auth", "claude_token_cleared"],
    ]);
    expect(JSON.stringify(audited).includes(TOKEN)).toBe(false);
    expect(JSON.stringify(lines).includes(TOKEN)).toBe(false);
    // The method that still has its placeholder (T18) and the purge (host mode: no VM runtime) keep answering as before.
    expect(await owner.client.call("agents.purgeTrash", { agentId: "scout-0001" })).toMatchObject({
      ok: false,
      error: { code: "sandbox_unavailable" },
    });
  }, 60_000);

  it("ask for the password again: a browser session that has not confirmed it is refused", async () => {
    t = await startTestDaemon({ steps: [{ text: "ok" }] });
    const cookie = await t.login();
    const client = await t.connect(cookie);
    try {
      const answer = await client.call("agents.vm.setClaudeToken", { token: TOKEN });
      expect(answer).toMatchObject({ ok: false, error: { code: "step_up_required" } });
      expect(existsSync(join(t.home, "secrets", "claude-token"))).toBe(false);
    } finally {
      client.close();
    }
  }, 60_000);

  it("push the token to the relay in vm mode, and again after the relay restarted", async () => {
    const child = Object.assign(new EventEmitter(), {
      sent: [] as unknown[],
      send(message: unknown) {
        this.sent.push(message);
        return true;
      },
      kill: () => true,
    });
    bed = await startVmBed(
      { steps: [{ text: "ok" }] },
      { seams: { relay: { fork: () => child as unknown as RelayChild } } },
    );
    child.emit("message", { type: "relay_ready", port: 1234 });
    await bed.call("agents.vm.setClaudeToken", { token: TOKEN });
    expect(child.sent).toContainEqual({ type: "claude_token", token: TOKEN });
    // A restarted relay is told again from the stored file, not from a copy in the daemon's memory.
    child.sent.length = 0;
    child.emit("message", { type: "relay_ready", port: 1235 });
    await vi.waitFor(() => expect(child.sent).toContainEqual({ type: "claude_token", token: TOKEN }));
    await bed.call("agents.vm.clearClaudeToken", {});
    expect(child.sent).toContainEqual({ type: "claude_token", token: null });
  }, 60_000);
});
