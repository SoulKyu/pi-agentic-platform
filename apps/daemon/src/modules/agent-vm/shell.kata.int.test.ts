import { afterEach, describe, expect, it } from "vitest";
import { type KataBed, LONG_MS, skipKata, startKataBed } from "../../testing/kata-bed.ts";

/*
 * T20b (RT-28): pap's own `bash` in a real VM. The probe tool (guest root, outside bwrap) shows what the shell must not reach.
 * Skips with one warning without /dev/kvm or pap-vmd; fails under CI=1.
 * Mutants (RT-43), each run for real:
 *  - the seccomp filter dropped from `bwrapVmArgv` (no `--seccomp`): killed by "refuses AF_VSOCK and a user namespace".
 *  - `--unshare-net` dropped: killed by "sees only lo".
 *  - `--unshare-pid` dropped: killed by "sees only the sandbox's processes".
 *  - `--tmpfs /tmp` dropped (two workers share the guest's /tmp): killed by "keeps two workers' shells apart".
 *  - `--tmpfs <agent root>` dropped (the `.pi` folder shows): killed by "has no .pi folder".
 */
const skip = skipKata();
let bed: KataBed | undefined;
afterEach(async (context) => {
  if (context.task.result?.state === "fail") process.stderr.write(`${bed?.problems().join("\n")}\n`);
  await bed?.stop();
  bed = undefined;
});

describe.skipIf(skip)("pap's shell in a VM (real Kata)", () => {
  it(
    "refuses AF_VSOCK and a user namespace with EPERM",
    async () => {
      bed = await startKataBed();
      const agentId = await bed.createAgent();
      const sessionId = await bed.openThread(agentId);
      const out = await bed.shell(
        agentId,
        sessionId,
        [
          "python3 -c 'import socket; socket.socket(40, 1)' 2>&1 | tail -1",
          'unshare -U true 2>&1; echo "userns-rc=$?"',
        ].join("; "),
      );
      expect(out).toMatch(/PermissionError: \[Errno 1\] Operation not permitted/);
      expect(out).toMatch(/unshare: .*Operation not permitted/);
      expect(out).toContain("userns-rc=1");
    },
    LONG_MS,
  );

  it(
    "has no .pi folder, and the root is read-only",
    async () => {
      bed = await startKataBed();
      const agentId = await bed.createAgent();
      const sessionId = await bed.openThread(agentId);
      // The probe is the worker itself (outside bwrap): it proves the folder exists in the guest, so the shell's view is a real hiding.
      expect(await bed.probe(agentId, sessionId, "ls -A /agent/.pi")).toContain("agent");
      const out = await bed.shell(
        agentId,
        sessionId,
        [
          'echo "pi-entries=$(ls -A /agent/.pi 2>/dev/null | wc -l)"',
          'echo "agent-entries=$(ls -A /agent | tr "\\n" " ")"',
          'touch /usr/pap-write-test 2>&1 | tail -1; echo "write-rc=$?"',
          'echo "home-write=$(touch /agent/home/ok && echo yes)"',
        ].join("; "),
      );
      expect(out).toContain("pi-entries=0");
      expect(out).not.toContain(".pi");
      expect(out).toMatch(/Read-only file system/);
      expect(out).toContain("home-write=yes");
    },
    LONG_MS,
  );

  it(
    "sees only the sandbox's processes and only lo",
    async () => {
      bed = await startKataBed();
      const agentId = await bed.createAgent();
      const sessionId = await bed.openThread(agentId);
      const script = [
        "import glob",
        "worker = 'dist/gu' + 'est/main.js'",
        "seen = []",
        "for p in glob.glob('/proc/[0-9]*/cmdline'):",
        "    try: seen.append(open(p, 'rb').read().replace(b'\\0', b' ').decode())",
        "    except OSError: pass",
        "print('PROCS', len(seen), 'WORKER', sum(1 for c in seen if worker in c))",
        "print('NET', open('/proc/net/dev').read().split('\\n')[2:])",
      ].join("\n");
      const encoded = Buffer.from(script).toString("base64");
      const inGuest = await bed.python(agentId, sessionId, script.replace("/proc/net/dev", "/proc/net/dev"));
      expect(inGuest).toMatch(/WORKER [1-9]/);
      expect(inGuest).toMatch(/eth0/);
      const out = await bed.shell(agentId, sessionId, `echo ${encoded} | base64 -d | python3 -`);
      const seen = /PROCS (\d+) WORKER (\d+)/.exec(out);
      expect(Number(seen?.[2])).toBe(0);
      expect(Number(seen?.[1])).toBeLessThan(10);
      expect(out).toContain("lo:");
      expect(out).not.toContain("eth0");
    },
    LONG_MS,
  );

  it(
    "keeps the shells of two workers of one VM apart while both run (R27)",
    async () => {
      bed = await startKataBed();
      const agentId = await bed.createAgent({ name: "Scout" });
      const sessionId = await bed.openThread(agentId);
      // The thread asks for two children in one message; they are two more workers of the same VM. Each shell writes its own
      // /tmp/mine, raises its flag in the shared /agent/home, waits for the other's flag, then reports what it sees.
      const shellOf = (me: string, peer: string): string =>
        [
          `echo ${me} > /tmp/mine`,
          `touch /agent/home/${me}-up`,
          `for i in $(seq 1 150); do [ -e /agent/home/${peer}-up ] && break; sleep 0.2; done`,
          `echo "${me.toUpperCase()}-REPORT peer=$([ -e /agent/home/${peer}-up ] && echo up || echo missing) mine=$(cat /tmp/mine) tmp=$(ls /tmp | tr '\\n' ' ')"`,
        ].join("; ");
      bed.llm.pushFor("SHELL-A", {
        tools: [
          { tool: "subagent", args: { task: "CHILD-ONE run your shell" } },
          { tool: "subagent", args: { task: "CHILD-TWO run your shell" } },
        ],
      });
      bed.llm.pushFor(
        "CHILD-ONE",
        { tool: "bash", args: { command: shellOf("a", "b") } },
        { text: "ONE-FINISHED" },
      );
      bed.llm.pushFor(
        "CHILD-TWO",
        { tool: "bash", args: { command: shellOf("b", "a") } },
        { text: "TWO-FINISHED" },
      );
      bed.llm.push({ text: "THREAD-FINISHED" });
      await bed.prompt(sessionId, "SHELL-A");
      const text = JSON.stringify(bed.transcript(agentId));
      expect(text).toContain("A-REPORT peer=up mine=a tmp=mine");
      expect(text).toContain("B-REPORT peer=up mine=b tmp=mine");
    },
    LONG_MS,
  );
});
