import { EventEmitter } from "node:events";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureLogger } from "../../testing/capture-logger.ts";
import { startTestDaemon, type TestDaemon } from "../../testing/harness.ts";
import { startVmBed, type VmBed } from "../../testing/vm-bed.ts";
import { openOwner, rows, type Owner } from "../../security/testing/automation-bed.ts";
import type { RelayChild } from "./relay-link.ts";

/*
 * AVM-P17, AVM-E2, RT-46 through a whole daemon: the two Claude-token methods are real in host and vm modes. Mutants (RT-43),
 * each run for real: the handlers dropped from `daemon.ts` (the stub answers sandbox_unavailable) -> both cases fail; the
 * (M14) the token is in the owner's vault and never a separate relay message; the value in a log line -> "no log line".
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
  it("store and remove the token without a VM stack, 0600 in a 0700 folder, and answer no value", async () => {
    const { logger, lines } = captureLogger();
    t = await startTestDaemon({ steps: [{ text: "ok" }] }, { deps: { logger } });
    owner = await openOwner(t);
    const legacy = join(t.home, "secrets", "claude-token");
    const vaultDir = join(t.home, "secrets", "vault");
    const set = await owner.client.call("agents.vm.setClaudeToken", { token: TOKEN });
    expect(set).toMatchObject({ ok: true, result: { ok: true } });
    expect(JSON.stringify(set).includes(TOKEN)).toBe(false);
    // M14: the token is sealed in the owner's vault, not in the old install-wide file.
    expect(existsSync(legacy)).toBe(false);
    expect(statSync(vaultDir).mode & 0o777).toBe(0o700);
    expect(readdirSync(vaultDir).length).toBeGreaterThan(1);
    expect(await owner.client.call("agents.vmStatus", {})).toMatchObject({
      ok: true,
      result: { claudeToken: "set" },
    });
    expect(await owner.client.call("agents.vm.clearClaudeToken", {})).toMatchObject({ ok: true });
    expect(await owner.client.call("agents.vmStatus", {})).toMatchObject({
      ok: true,
      result: { claudeToken: "missing" },
    });
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
    // The purge of an agent that is not in the owner's trash answers not_found.
    expect(await owner.client.call("agents.purgeTrash", { agentId: "scout-0001" })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  }, 60_000);

  it("ask for the password again: a browser session that has not confirmed it is refused", async () => {
    t = await startTestDaemon({ steps: [{ text: "ok" }] });
    const cookie = await t.login();
    const client = await t.connect(cookie);
    try {
      const answer = await client.call("agents.vm.setClaudeToken", { token: TOKEN });
      expect(answer).toMatchObject({ ok: false, error: { code: "step_up_required" } });
      expect(existsSync(join(t.home, "secrets", "vault"))).toBe(false);
    } finally {
      client.close();
    }
  }, 60_000);

  it("never sends a claude_token message to the relay: the token travels in the box policy", async () => {
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
    expect(await bed.call("agents.vmStatus", {})).toMatchObject({ claudeToken: "set" });
    child.emit("message", { type: "relay_ready", port: 1235 });
    await bed.call("agents.vm.clearClaudeToken", {});
    expect(await bed.call("agents.vmStatus", {})).toMatchObject({ claudeToken: "missing" });
    expect(JSON.stringify(child.sent)).not.toContain(TOKEN);
    expect(child.sent.some((message) => (message as { type: string }).type === "claude_token")).toBe(false);
  }, 60_000);
});
