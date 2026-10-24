import { afterEach, describe, expect, it } from "vitest";
import { type KataBed, LONG_MS, skipKata, startKataBed, vmsOf } from "../../testing/kata-bed.ts";

/*
 * T20a: a whole daemon on the real Kata stack (KVM, pap-vmd, the real relay, a scripted model on loopback). Skips with one
 * warning without /dev/kvm or pap-vmd; fails under CI=1. The probe tool runs commands inside the VM as the worker.
 * Mutants (RT-43), each run for real:
 *  - the guest keeps the gateway token in its environment (the re-exec in takeGatewayToken dropped): killed by "no process of the VM holds the launch token".
 *  - `growFilesystem` skipped at the guest's start: killed by "grows the file system at the next boot".
 */
const skip = skipKata();
let bed: KataBed | undefined;
afterEach(async (context) => {
  if (context.task.result?.state === "fail") process.stderr.write(`${bed?.problems().join("\n")}\n`);
  await bed?.stop();
  bed = undefined;
});
/** Quarantine's step deadline (`QUARANTINE_STEP_MS` in modules/agents/quarantine.ts, which a module may not import). */
const QUARANTINE_STEP_MS = 10_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const mib = (kb: number) => Math.round(kb / 1024);

describe.skipIf(skip)("the Kata backend on the real stack", () => {
  it(
    "runs a thread: open, prompt, answer, then the idle stop",
    async () => {
      bed = await startKataBed({ workerIdleMs: 20_000 });
      bed.llm.push({ text: "Hello from the VM." });
      const agentId = await bed.createAgent();
      const sessionId = await bed.openThread(agentId);
      await bed.prompt(sessionId, "Say hello");
      expect(JSON.stringify(bed.transcript(agentId))).toContain("Hello from the VM.");
      expect((await vmsOf(bed.vmd, agentId)).map((vm) => vm.state)).toEqual(["running"]);
      // The idle timer stops the VM once the worker has been unused for workerIdleMs.
      const deadline = Date.now() + 120_000;
      while ((await vmsOf(bed.vmd, agentId)).length > 0) {
        if (Date.now() > deadline) throw new Error("the VM did not stop when idle");
        await sleep(1_000);
      }
    },
    LONG_MS,
  );

  it(
    "answers the history of a stopped VM without starting it, and a real stop fits quarantine's step",
    async () => {
      bed = await startKataBed();
      bed.llm.push({ text: "First answer." });
      const agentId = await bed.createAgent();
      const sessionId = await bed.openThread(agentId);
      await bed.prompt(sessionId, "First question");
      const stopping = Date.now();
      await bed.vm.runtime.stop({ kind: "agent", id: agentId });
      const took = Date.now() - stopping;
      process.stderr.write(
        `T20a runtime.stop of a running thread VM: ${took} ms (quarantine step ${QUARANTINE_STEP_MS} ms)\n`,
      );
      expect(took).toBeLessThan(QUARANTINE_STEP_MS);
      expect(await vmsOf(bed.vmd, agentId)).toEqual([]);

      const entries = bed.transcript(agentId);
      const last = entries.at(-1) as { id: string };
      const { rows } = await bed.call<{ rows: Array<{ message: { role: string; content: unknown } }> }>(
        "sessions.history",
        { sessionId, before: last.id },
      );
      expect(JSON.stringify(rows)).toContain("First question");
      expect(bed.starts).toHaveLength(1);
      expect(await vmsOf(bed.vmd, agentId)).toEqual([]);
    },
    LONG_MS,
  );

  it(
    "no process of the VM holds the launch token (R24), and the agent folder holds none",
    async () => {
      bed = await startKataBed();
      const agentId = await bed.createAgent();
      const sessionId = await bed.openThread(agentId);
      const token = bed.starts.at(-1)?.token ?? "";
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      const half = token.length / 2;
      const out = await bed.python(
        agentId,
        sessionId,
        [
          "import os, glob",
          `t = (${JSON.stringify(token.slice(0, half))} + ${JSON.stringify(token.slice(half))}).encode()`,
          "me = os.getpid(); hits = []; seen = 0",
          "for p in glob.glob('/proc/[0-9]*'):",
          "    pid = int(p[6:])",
          "    if pid == me: continue",
          "    seen += 1",
          "    for f in ('environ', 'cmdline'):",
          "        try: d = open(p + '/' + f, 'rb').read()",
          "        except OSError: continue",
          "        if t in d or b'PAP_GATEWAY' + b'_TOKEN' in d: hits.append([pid, f])",
          "print('SEEN', seen, 'HITS', hits)",
          "for root, _, files in os.walk('/agent'):",
          "    for name in files:",
          "        try: d = open(os.path.join(root, name), 'rb').read()",
          "        except OSError: continue",
          "        if t in d: print('FILE', os.path.join(root, name))",
        ].join("\n"),
      );
      const seen = /SEEN (\d+) HITS (\[.*\])/.exec(out);
      expect(Number(seen?.[1])).toBeGreaterThanOrEqual(3);
      expect(seen?.[2]).toBe("[]");
      expect(out).not.toContain("FILE");
      expect(out).not.toContain(token);
    },
    LONG_MS,
  );

  it(
    "has no socket file in the guest root outside /tmp, /run, /dev, /proc and /agent (T11a)",
    async () => {
      bed = await startKataBed();
      const agentId = await bed.createAgent();
      const sessionId = await bed.openThread(agentId);
      const out = await bed.probe(
        agentId,
        sessionId,
        "find / -type s -not -path '/proc/*' -not -path '/sys/*' -not -path '/dev/*' -not -path '/run/*' -not -path '/tmp/*' -not -path '/agent/*' 2>/dev/null; echo end",
      );
      expect(out.trim()).toBe("end\n\nexit: 0");
    },
    LONG_MS,
  );

  it(
    "copies a link of a package as a link and leaves one that leaves the package out of the image (AVM-P19)",
    async () => {
      bed = await startKataBed();
      const agentId = await bed.createAgent();
      const sessionId = await bed.openThread(agentId);
      const out = await bed.probe(
        agentId,
        sessionId,
        'cd /opt/pap/pi-agent/local/probe && echo "alias=$(readlink alias.js)" && ls',
      );
      expect(out).toContain("alias=index.js");
      expect(out).toContain("index.js");
      expect(out).not.toContain("outside");
    },
    LONG_MS,
  );

  it(
    "gives an isolated task VM a blank disk that goes with its stop, and the agent's own VM keeps its marker",
    async () => {
      bed = await startKataBed({ workerIdleMs: 20_000 });
      const scout = await bed.createAgent({ name: "Scout", acceptsDelegation: true });
      const atlas = await bed.createAgent({ name: "Atlas" });
      const scoutSession = await bed.openThread(scout);
      await bed.probe(scout, scoutSession, "echo scout-marker > /agent/home/marker && sync");
      const atlasSession = await bed.openThread(atlas);
      // Atlas reads an extension tool's result (the probe), which taints it: its delegation then runs in an isolated task VM.
      bed.llm.pushFor(
        "ATLAS-GO",
        { tool: "probe", args: { cmd: "echo external" } },
        { tool: "agent_delegate", args: { agent: "Scout", task: "TASKCHECK list your home" } },
        { text: "Delegated." },
      );
      bed.llm.pushFor(
        "TASKCHECK",
        { tool: "ls", args: { path: "/agent/home" } },
        { tool: "read", args: { path: "/agent/home/marker" } },
        { text: "TASK-FINISHED" },
      );
      await bed.prompt(atlasSession, "ATLAS-GO");
      const deadline = Date.now() + 240_000;
      let sawTaskVm = false;
      for (;;) {
        const vms = await vmsOf(bed.vmd, scout);
        sawTaskVm ||= vms.some((vm) => vm.taskKey !== null);
        const done = JSON.stringify(bed.transcript(scout)).includes("TASK-FINISHED");
        if (sawTaskVm && done && vms.every((vm) => vm.taskKey === null)) break;
        if (Date.now() > deadline)
          throw new Error(`the task did not end: ${JSON.stringify(vms)} done=${done}`);
        await sleep(1_000);
      }
      const results = bed
        .transcript(scout)
        .filter((entry) => (entry.message as { role?: string } | undefined)?.role === "toolResult")
        .map((entry) => JSON.stringify(entry.message));
      // The task's `ls` of its own /agent/home found nothing, and reading the marker failed.
      const ls = results.find((text) => text.includes('"toolName":"ls"')) ?? "";
      const read = results.find((text) => text.includes('"toolName":"read"')) ?? "";
      expect(ls).toContain('"isError":false');
      expect(ls).toContain("(empty directory)");
      expect(read).toContain('"isError":true');
      expect(read).toContain("missing");
      expect(read).not.toContain("scout-marker");
      // The task VM (stopped by the idle timer, with its disk) is gone; vmd has no op that lists disks, so the VM list is the proof; Scout's own disk still holds its marker, whether its VM
      // stayed up or was stopped by the same timer and started again by this probe.
      expect((await vmsOf(bed.vmd, scout)).filter((vm) => vm.taskKey !== null)).toEqual([]);
      await bed.call("sessions.reopen", { sessionId: scoutSession });
      expect(await bed.probe(scout, scoutSession, "cat /agent/home/marker")).toContain("scout-marker");
    },
    LONG_MS,
  );

  it("grows the file system at the next boot after the disk file grew", async () => {
    bed = await startKataBed();
    const agentId = await bed.createAgent({ resources: { memoryMb: 1024, cpus: 1, diskMb: 1024 } });
    const sessionId = await bed.openThread(agentId);
    const sizeOf = async (): Promise<number> => {
      const out = await bed?.probe(agentId, sessionId, "df -k /agent | tail -1");
      return Number(/\s(\d+)\s+\d+\s+\d+\s+\d+%/.exec(out ?? "")?.[1]);
    };
    await bed.probe(agentId, sessionId, "echo t20a-marker > /agent/home/marker && sync");
    const before = mib(await sizeOf());
    expect(before).toBeLessThan(1100);
    await bed.vm.runtime.stop({ kind: "agent", id: agentId });
    await bed.update(agentId, { resources: { memoryMb: 1024, cpus: 1, diskMb: 2048 } });
    await bed.call("sessions.reopen", { sessionId });
    const after = mib(
      await bed
        .probe(agentId, sessionId, "df -k /agent | tail -1")
        .then((out) => Number(/\s(\d+)\s+\d+\s+\d+\s+\d+%/.exec(out)?.[1])),
    );
    expect(after).toBeGreaterThan(1900);
    // The disk is the agent's own and survives the VM: what the first boot wrote is there after the grow.
    expect(await bed.probe(agentId, sessionId, "cat /agent/home/marker")).toContain("t20a-marker");
  }, 300_000);
});
