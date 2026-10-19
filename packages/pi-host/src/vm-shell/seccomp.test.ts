import { describe, expect, it } from "vitest";
import {
  ARG_SYSCALLS,
  CLONE_NEW_MASK,
  DENIED_SYSCALLS,
  encodeSeccomp,
  type Insn,
  shellSeccompProgram,
  SOCKET_FAMILIES,
} from "./seccomp.ts";

/*
 * Mutants (RT-43), each applied to seccomp.ts by hand and run for real; the case that kills it:
 *  - M1 drop the arch check (no ld ARCH / jeq)            -> "kills aarch64 and i386"
 *  - M2 drop the x32 check (JGE X32_SYSCALL_BIT)          -> "kills an x32 number"
 *  - M3 allow every socket family (drop the family jeq)   -> "refuses socket for a family outside the list"
 *  - M4 change a denied number (ptrace 101 -> 102)        -> "refuses every number of DENIED_SYSCALLS"
 *  - M5 drop the namespace mask (JSET -> allow)           -> "refuses clone and unshare with any CLONE_NEW flag"
 *  - M6 allow clone3 (drop its jeq)                       -> "answers clone3 with ENOSYS"
 */

const AUDIT_ARCH_X86_64 = 0xc000003e;
const AUDIT_ARCH_AARCH64 = 0xc00000b7;
const AUDIT_ARCH_I386 = 0x40000003;
const RET_ALLOW = 0x7fff0000;
const RET_KILL_PROCESS = 0x80000000;
const EPERM = 0x00050001;
const ENOSYS = 0x00050026;

/** A classic BPF interpreter for the five opcodes the filter uses; anything else throws. */
function run(
  program: readonly Insn[],
  { arch = AUDIT_ARCH_X86_64, nr, arg0 = 0n }: { arch?: number; nr: number; arg0?: bigint },
): number {
  const data = Buffer.alloc(64);
  data.writeUInt32LE(nr, 0);
  data.writeUInt32LE(arch, 4);
  data.writeBigUInt64LE(arg0, 16);
  let acc = 0;
  let pc = 0;
  for (let steps = 0; steps < 1000; steps++) {
    const insn = program[pc];
    if (!insn) throw new Error(`fell off the program at ${pc}`);
    const [code, jt, jf, k] = insn;
    pc++;
    if (code === 0x20) acc = data.readUInt32LE(k);
    else if (code === 0x15) pc += acc === k ? jt : jf;
    else if (code === 0x35) pc += acc >= k ? jt : jf;
    else if (code === 0x45) pc += (acc & k) !== 0 ? jt : jf;
    else if (code === 0x06) return k;
    else throw new Error(`unknown opcode ${code}`);
  }
  throw new Error("no return");
}

const program = shellSeccompProgram();
const verdict = (nr: number, arg0 = 0n, arch = AUDIT_ARCH_X86_64) => run(program, { arch, nr, arg0 });

const SYS = { read: 0, write: 1, execve: 59, getpid: 39, fork: 57 };
const CLONE_FORK = 0x01200011n; // CLONE_CHILD_SETTID|CLONE_CHILD_CLEARTID|SIGCHLD, glibc fork()
const CLONE_THREAD = 0x003d0f00n; // CLONE_VM|FS|FILES|SIGHAND|THREAD|SYSVSEM|SETTLS|PARENT_SETTID|CHILD_CLEARTID
const NEW_FLAGS = [0x80, 0x20000, 0x2000000, 0x4000000, 0x8000000, 0x10000000, 0x20000000, 0x40000000];

describe("shellSeccompProgram", () => {
  it("is 63 instructions and encodes to 8 bytes each", () => {
    expect(program).toHaveLength(63);
    expect(encodeSeccomp(program)).toHaveLength(504);
    expect(encodeSeccomp([])).toHaveLength(0);
  });

  it("encodes little-endian code, jt, jf and k", () => {
    const buffer = encodeSeccomp([[0x1234, 0x56, 0x78, 0x9abcdef0]]);
    expect([...buffer]).toEqual([0x34, 0x12, 0x56, 0x78, 0xf0, 0xde, 0xbc, 0x9a]);
    const real = encodeSeccomp(program);
    expect(real.readUInt16LE(0)).toBe(0x20);
    expect(real.readUInt32LE(4)).toBe(4);
  });

  it("every jump stays inside the program and the last instruction returns", () => {
    program.forEach(([code, jt, jf], i) => {
      if (code === 0x06) return;
      expect(i + 1 + jt).toBeLessThan(program.length);
      expect(i + 1 + jf).toBeLessThan(program.length);
    });
    expect(program.at(-1)?.[0]).toBe(0x06);
  });

  it("allows read, write, execve, getpid and fork-style calls", () => {
    for (const nr of Object.values(SYS)) expect(verdict(nr)).toBe(RET_ALLOW);
  });

  it("allows socket for AF_UNIX, AF_INET, AF_INET6 and AF_NETLINK", () => {
    expect([...SOCKET_FAMILIES]).toEqual([1, 2, 10, 16]);
    for (const family of [1n, 2n, 10n, 16n]) expect(verdict(ARG_SYSCALLS.socket, family)).toBe(RET_ALLOW);
  });

  it("allows socketpair(AF_UNIX)", () => {
    expect(verdict(ARG_SYSCALLS.socketpair, 1n)).toBe(RET_ALLOW);
  });

  it("allows clone with fork's and a thread's flags and unshare(CLONE_FILES)", () => {
    expect(verdict(ARG_SYSCALLS.clone, CLONE_FORK)).toBe(RET_ALLOW);
    expect(verdict(ARG_SYSCALLS.clone, CLONE_THREAD)).toBe(RET_ALLOW);
    expect(verdict(ARG_SYSCALLS.unshare, 0x400n)).toBe(RET_ALLOW);
  });

  it("refuses socket for a family outside the list, vsock (40) included, even with the upper 32 bits set", () => {
    for (const family of [40n, 17n, 38n, 44n, 0n, 3n, 9n, 255n])
      expect(verdict(ARG_SYSCALLS.socket, family)).toBe(EPERM);
    expect(verdict(ARG_SYSCALLS.socket, 40n | (1n << 32n))).toBe(EPERM);
    expect(verdict(ARG_SYSCALLS.socket, 40n | (0xffffffffn << 32n))).toBe(EPERM);
  });

  it("refuses socketpair for every family but AF_UNIX", () => {
    for (const family of [40n, 2n, 10n, 16n, 17n])
      expect(verdict(ARG_SYSCALLS.socketpair, family)).toBe(EPERM);
  });

  it("refuses clone and unshare with any CLONE_NEW flag", () => {
    expect(NEW_FLAGS.reduce((mask, flag) => mask | flag, 0)).toBe(CLONE_NEW_MASK);
    for (const flag of NEW_FLAGS) {
      for (const nr of [ARG_SYSCALLS.clone, ARG_SYSCALLS.unshare]) {
        expect(verdict(nr, BigInt(flag))).toBe(EPERM);
        expect(verdict(nr, CLONE_FORK | BigInt(flag))).toBe(EPERM);
      }
    }
  });

  it("answers clone3 with ENOSYS", () => {
    expect(verdict(ARG_SYSCALLS.clone3)).toBe(ENOSYS);
    expect(verdict(ARG_SYSCALLS.clone3, 0x10000000n)).toBe(ENOSYS);
  });

  it("refuses every number of DENIED_SYSCALLS", () => {
    const entries = Object.entries(DENIED_SYSCALLS);
    expect(entries).toHaveLength(38);
    expect(new Set(Object.values(DENIED_SYSCALLS)).size).toBe(entries.length);
    for (const [name, nr] of entries) expect(verdict(nr), name).toBe(EPERM);
    // Pinned numbers (syscall_64.tbl) for the ones R18 names.
    expect(DENIED_SYSCALLS).toMatchObject({
      ptrace: 101,
      mount: 165,
      setns: 308,
      process_vm_readv: 310,
      bpf: 321,
      userfaultfd: 323,
      io_uring_setup: 425,
      fsopen: 430,
      pidfd_getfd: 438,
    });
  });

  it("kills aarch64 and i386, whatever the number", () => {
    for (const arch of [AUDIT_ARCH_AARCH64, AUDIT_ARCH_I386, 0, 0xc000003f])
      for (const nr of [SYS.read, SYS.execve, ARG_SYSCALLS.socket, DENIED_SYSCALLS.ptrace])
        expect(verdict(nr, 0n, arch)).toBe(RET_KILL_PROCESS);
  });

  it("kills an x32 number", () => {
    for (const nr of [0x40000000 + 41, 0x40000000, 0x40000000 + 1, 0xffffffff])
      expect(verdict(nr)).toBe(RET_KILL_PROCESS);
    expect(verdict(0x3fffffff)).toBe(RET_ALLOW);
  });
});
