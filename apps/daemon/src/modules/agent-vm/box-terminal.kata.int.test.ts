import { afterEach, describe, expect, it } from "vitest";
import { FRAME_OPS, type ProjectView } from "@pap/contracts";
import { attach, createTerminal, untilText } from "../terminal/testing/wire.ts";
import { type KataBed, LONG_MS, skipKata, startKataBed } from "../../testing/kata-bed.ts";

/*
 * Boxes lot B2, the real stack: a terminal in a project's Kata microVM. The guest opens a pty (node-pty built into the image),
 * the daemon relays its bytes, and `exit` ends the shell. Skips with one warning without /dev/kvm or pap-vmd; fails under CI=1.
 * Run in J3, in the root window (the first start builds the box's image).
 */
const skip = skipKata();
let bed: KataBed | undefined;
let projectId: string | undefined;
afterEach(async (context) => {
  if (context.task.result?.state === "fail") process.stderr.write(`${bed?.problems().join("\n")}\n`);
  if (bed && projectId) {
    // The box and its disk are the test's: stopped and deleted for good, not kept in pap-vmd's trash for a week.
    const box = { kind: "project", id: projectId } as const;
    await bed.vmd.request({ op: "vm.stop", box, taskKey: null }).catch(() => undefined);
    await bed.vmd.request({ op: "disk.delete", box, taskKey: null, purge: true }).catch(() => undefined);
  }
  await bed?.stop();
  bed = undefined;
  projectId = undefined;
});

describe.skipIf(skip)("a terminal in a project's box on the real stack", () => {
  it(
    "a real terminal in a real box echoes and exits",
    async () => {
      bed = await startKataBed({ probe: false });
      const { project } = await bed.call<{ project: ProjectView }>("projects.create", { name: "Kata shell" });
      projectId = project.id;
      const client = bed.owner.client;

      // terminal.create starts the box (minutes the first time) and opens a shell in the project folder.
      const terminalId = await createTerminal(client, project.root);
      const stream = await attach(client, terminalId);
      stream.type("echo kata-$((20+22)); pwd\r");
      await untilText(stream, "kata-42", LONG_MS);
      await untilText(stream, project.root, LONG_MS);

      stream.type("exit\r");
      const exit = await client.waitForBinary(
        (frame) => frame.op === FRAME_OPS.exit && frame.streamId === stream.streamId,
        LONG_MS,
      );
      expect(JSON.parse(Buffer.from(exit.payload).toString("utf8"))).toEqual({ code: 0, signal: null });
    },
    LONG_MS,
  );
});
