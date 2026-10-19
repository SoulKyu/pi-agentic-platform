import { describe, expect, it } from "vitest";
import { AgentInput } from "./agents.ts";
import { AgentResources, PackagePicks, SystemPackage, SystemPackages } from "./agents-resources.ts";
import {
  FILE_CHUNK_B64,
  FilePut,
  GuestCommand,
  GuestReport,
  Hello,
  SESSION_CHUNK_B64,
  SessionAppend,
  SessionResync,
  VmInit,
} from "./agents-vm.ts";
import { QUARANTINE_STEPS } from "./agents-safety.ts";
import { DaemonToWorker, parseWorkerRecord } from "./pi-host.ts";
import { AGENT_VM_MAX_FRAME_BYTES, MAX_FRAME_BYTES } from "./index.ts";
import { TranscriptRow } from "./streams.ts";

const hex = (n: number, ch = "a"): string => ch.repeat(n);
const TAG = `pap-agent-agent-${hex(64, "b")}`;
const guestHello = {
  type: "hello",
  role: "guest",
  agentId: "helper-1a2b",
  launchId: hex(32),
  token: hex(64),
  protocol: 1,
  imageTag: TAG,
};
const workerHello = {
  ...guestHello,
  role: "worker",
  slot: hex(32, "c"),
  session: { file: "s.jsonl", lastEntryId: null, size: 0 },
};
const layout = {
  root: "/agent",
  home: "/agent/home",
  knowledge: "/agent/knowledge",
  inbox: "/agent/inbox",
  pi: "/agent/.pi",
  sessions: "/agent/.pi/sessions",
  piAgentDir: "/agent/.pi/agent",
  imageAgentDir: "/opt/pap/pi-agent",
  shellOverlay: "/run/pap-shell",
};
const vmInit = {
  layout,
  bwrap: "/usr/bin/bwrap",
  relayKey: hex(64, "d"),
  slot: hex(32, "c"),
  rootView: "read-only",
};

describe("agent resources and packages", () => {
  it("fills the defaults and still parses a profile stored without the fields", () => {
    const parsed = AgentInput.parse({ name: "A" });
    expect(parsed.resources).toEqual({ memoryMb: 1024, cpus: 1, diskMb: 4096 });
    expect(parsed.systemPackages).toEqual([]);
    expect(parsed.packages).toBeNull();
  });

  it("accepts Debian package names and refuses anything apt could read as an option or a command", () => {
    for (const name of ["jq", "python3", "g++", "libc6-dev"])
      expect(SystemPackage.safeParse(name).success).toBe(true);
    for (const name of ["Jq", "-x", "a b", "a;b", "$(x)", "a".repeat(64)]) {
      expect(SystemPackage.safeParse(name).success, name).toBe(false);
    }
  });

  it("refuses a duplicate system package and a 65th entry", () => {
    expect(SystemPackages.safeParse(["jq", "jq"]).success).toBe(false);
    const sixtyFour = Array.from({ length: 64 }, (_, index) => `pkg${index}`);
    expect(SystemPackages.safeParse(sixtyFour).success).toBe(true);
    expect(SystemPackages.safeParse([...sixtyFour, "extra"]).success).toBe(false);
  });

  it("refuses a pick with a hidden character and a duplicate pick, and accepts null", () => {
    expect(PackagePicks.safeParse(["npm:pkg@1.0.0"]).success).toBe(true);
    expect(PackagePicks.safeParse(null).success).toBe(true);
    expect(PackagePicks.safeParse([`a${String.fromCharCode(0x202e)}b`]).success).toBe(false);
    expect(PackagePicks.safeParse(["a", "a"]).success).toBe(false);
  });

  it("bounds the resources and refuses unknown keys", () => {
    const base = { memoryMb: 1024, cpus: 1, diskMb: 4096 };
    expect(AgentResources.safeParse(base).success).toBe(true);
    for (const bad of [{ memoryMb: 511 }, { diskMb: 65_537 }, { cpus: 0 }, { cpus: 1.5 }, { extra: 1 }]) {
      expect(AgentResources.safeParse({ ...base, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("hello", () => {
  it("accepts a guest and a worker hello", () => {
    expect(Hello.safeParse(guestHello).success).toBe(true);
    expect(Hello.safeParse(workerHello).success).toBe(true);
  });

  it("refuses a token of the wrong length or case, a foreign image tag, another protocol and unknown keys", () => {
    const bad = [
      { token: hex(63) },
      { token: hex(65) },
      { token: hex(64, "A") },
      { imageTag: "pap-agent-agent-latest" },
      { imageTag: `other-agent-${hex(64)}` },
      { protocol: 2 },
      { extra: 1 },
    ];
    for (const patch of bad)
      expect(Hello.safeParse({ ...guestHello, ...patch }).success, JSON.stringify(patch)).toBe(false);
  });

  it("refuses a worker hello without a slot or with a session file that leaves the folder", () => {
    const withoutSlot: Record<string, unknown> = { ...workerHello };
    delete withoutSlot.slot;
    expect(Hello.safeParse(withoutSlot).success).toBe(false);
    expect(
      Hello.safeParse({ ...workerHello, session: { file: "../s.jsonl", lastEntryId: null, size: 0 } })
        .success,
    ).toBe(false);
  });
});

describe("worker and guest records", () => {
  const append = { type: "session_append", file: "s.jsonl", offset: 0, data: "aGk=", replace: false };

  it("checks a session_append", () => {
    expect(SessionAppend.safeParse(append).success).toBe(true);
    for (const patch of [
      { data: "not base64!" },
      { data: "A".repeat(SESSION_CHUNK_B64 + 4) },
      { offset: -1 },
      { file: "s.txt" },
      { file: "a/s.jsonl" },
    ]) {
      expect(
        SessionAppend.safeParse({ ...append, ...patch }).success,
        JSON.stringify(patch).slice(0, 40),
      ).toBe(false);
    }
  });

  it("accepts only canonical base64", () => {
    for (const data of ["abc", "aGk", "aGk==", "=aGk", "a=Gk", "aG k"]) {
      expect(SessionAppend.safeParse({ ...append, data }).success, data).toBe(false);
    }
    for (const data of ["", "aGk=", "aA==", "aGkh"]) {
      expect(SessionAppend.safeParse({ ...append, data }).success, data).toBe(true);
    }
  });

  it("bounds what the VM names: a signal and an entry id", () => {
    const exited = { type: "exited", slot: hex(32), code: null, tail: "" };
    for (const signal of ["SIGTERM", "SIGRTMIN1", null]) {
      expect(GuestReport.safeParse({ ...exited, signal }).success, String(signal)).toBe(true);
    }
    for (const signal of ["sigterm", "TERM", "SIG", `SIG${"A".repeat(14)}`, "SIGT\nERM"]) {
      expect(GuestReport.safeParse({ ...exited, signal }).success, signal).toBe(false);
    }
    const session = (lastEntryId: string) => ({
      ...workerHello,
      session: { file: "s.jsonl", lastEntryId, size: 0 },
    });
    for (const code of [0x0a, 0x202e, 0x200b, 0x2028]) {
      const id = `e${String.fromCharCode(code)}1`;
      expect(Hello.safeParse(session(id)).success, String(code)).toBe(false);
      expect(
        SessionResync.safeParse({ type: "session_resync", fromOffset: 0, lastEntryId: id }).success,
      ).toBe(false);
    }
    expect(Hello.safeParse(session("a1b2c3d4")).success).toBe(true);
  });

  it("checks a file_put", () => {
    const put = { type: "file_put", id: hex(32), name: "report.txt", offset: 0, data: "aGk=", last: true };
    expect(FilePut.safeParse(put).success).toBe(true);
    const names = [".x", "../x", "a/b", `a${String.fromCharCode(0)}b`, "a".repeat(129)];
    for (const name of names) expect(FilePut.safeParse({ ...put, name }).success, name).toBe(false);
    expect(FilePut.safeParse({ ...put, data: "A".repeat(FILE_CHUNK_B64 + 4) }).success).toBe(false);
  });

  it("refuses a relative sessionFile in spawn and a relative layout path in VmInit", () => {
    const spawn = {
      type: "spawn",
      slot: hex(32),
      sessionFile: "/agent/.pi/sessions/s.jsonl",
      packages: null,
    };
    expect(GuestCommand.safeParse(spawn).success).toBe(true);
    expect(GuestCommand.safeParse({ ...spawn, sessionFile: "s.jsonl" }).success).toBe(false);
    expect(VmInit.safeParse(vmInit).success).toBe(true);
    expect(VmInit.safeParse({ ...vmInit, layout: { ...layout, home: "home" } }).success).toBe(false);
  });
});

describe("pi-host wiring", () => {
  it("routes the new worker records to the daemon as pap records, never as Pi events", () => {
    const record = parseWorkerRecord({
      type: "session_append",
      file: "s.jsonl",
      offset: 0,
      data: "",
      replace: true,
    });
    expect(record?.type).toBe("session_append");
    const result = parseWorkerRecord({ type: "file_put_result", id: hex(32), ok: true });
    expect(result?.type).toBe("file_put_result");
    expect(parseWorkerRecord({ type: "session_append", file: "../x" })).toBeNull();
  });

  it("accepts session_resync and file_put from the daemon and a vm field on init", () => {
    expect(
      DaemonToWorker.safeParse({ type: "session_resync", fromOffset: 0, lastEntryId: null }).success,
    ).toBe(true);
    const init = {
      type: "init",
      cwd: "/a",
      agentDir: "/b",
      papHome: "/c",
      umask: 0o22,
      policy: {},
      vm: vmInit,
    };
    expect(DaemonToWorker.safeParse(init).success).toBe(true);
    expect(DaemonToWorker.safeParse({ ...init, vm: { ...vmInit, rootView: "bind" } }).success).toBe(false);
  });

  it("refuses a vault, one-use values or memory on the init of a VM worker (R11, R17)", () => {
    const init = {
      type: "init",
      cwd: "/a",
      agentDir: "/b",
      papHome: "/c",
      umask: 0o22,
      policy: {},
      vm: vmInit,
    };
    for (const extra of [
      { vault: { ABC: "x" } },
      { once: [] },
      { memory: { profile: "p", trust: "trusted" } },
    ]) {
      expect(DaemonToWorker.safeParse({ ...init, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
    const host: Record<string, unknown> = { ...init };
    delete host.vm;
    expect(DaemonToWorker.safeParse({ ...host, vault: { ABC: "x" } }).success).toBe(true);
  });

  it("marks a user entry pap did not send, and quarantines the VM first", () => {
    expect(TranscriptRow.safeParse({ entryId: "e1", message: {}, unverified: true }).success).toBe(true);
    expect(TranscriptRow.safeParse({ entryId: "e1", message: {}, unverified: false }).success).toBe(false);
    expect(QUARANTINE_STEPS[0]).toBe("vm");
  });
});

describe("frame bounds", () => {
  it("keeps the WebSocket bound under the bare name and the gateway bound under its own name", () => {
    expect(MAX_FRAME_BYTES).toBe(1024 * 1024);
    expect(AGENT_VM_MAX_FRAME_BYTES).toBe(4 * 1024 * 1024);
  });
});
