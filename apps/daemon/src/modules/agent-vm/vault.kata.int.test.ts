import { afterEach, describe, expect, it } from "vitest";
import { type KataBed, LONG_MS, skipKata, startKataBed } from "../../testing/kata-bed.ts";

/*
 * ADR 0081: the vault reaches pap's own `bash` in a real VM. The process backend cannot run the root VM shell, so what the
 * shell is given is proven here (and in `vm-shell/ops.vault.test.ts` with an injected spawn). Skips with one warning without
 * /dev/kvm or pap-vmd; fails under CI=1. Runs in the join's root window, never in a task's gate.
 */
const skip = skipKata();
const VALUE = "kata-vault-value-3c8e51a7";
const LIVE = "kata-live-value-9d20b6f4";
let bed: KataBed | undefined;
afterEach(async (context) => {
  if (context.task.result?.state === "fail") process.stderr.write(`${bed?.problems().join("\n")}\n`);
  await bed?.stop();
  bed = undefined;
});

describe.skipIf(skip)("the vault in pap's shell in a VM (real Kata)", () => {
  it(
    "gives the shell the vault's values, redacted in what the model is given, and never the relay key",
    async () => {
      bed = await startKataBed();
      const agentId = await bed.createAgent();
      await bed.call("secrets.set", { agentId, name: "KATA_VAULT", value: VALUE });
      const sessionId = await bed.openThread(agentId);
      const out = await bed.shell(
        agentId,
        sessionId,
        'echo "vault=[$KATA_VAULT]"; echo "len=${#KATA_VAULT}"; env | grep -c PAP_RELAY || true',
      );
      expect(out).toContain("vault=[[SECRET:KATA_VAULT]]");
      expect(out).toContain(`len=${VALUE.length}`);
      expect(out).not.toContain(VALUE);
      expect(out.trim().endsWith("0")).toBe(true);
    },
    LONG_MS,
  );

  it(
    "delivers a vault value saved while the VM runs to the next command",
    async () => {
      bed = await startKataBed();
      const agentId = await bed.createAgent();
      const sessionId = await bed.openThread(agentId);
      expect(await bed.shell(agentId, sessionId, 'echo "before=[$KATA_LIVE]"')).toContain("before=[]");
      await bed.call("secrets.set", { agentId, name: "KATA_LIVE", value: LIVE });
      const out = await bed.shell(agentId, sessionId, 'echo "after=[$KATA_LIVE]"');
      expect(out).toContain("after=[[SECRET:KATA_LIVE]]");
      expect(out).not.toContain(LIVE);
    },
    LONG_MS,
  );
});
