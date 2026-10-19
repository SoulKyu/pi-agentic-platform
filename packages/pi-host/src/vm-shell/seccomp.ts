/** Classic BPF for seccomp (linux/filter.h, linux/seccomp.h). x86_64 only in v1: any other arch is killed (R2, R18). */
const LD_W_ABS = 0x20;
const JEQ_K = 0x15;
const JGE_K = 0x35;
const JSET_K = 0x45;
const RET_K = 0x06;
const RET_ALLOW = 0x7fff0000;
const RET_KILL_PROCESS = 0x80000000;
const RET_ERRNO = 0x00050000;
const EPERM = 1;
const ENOSYS = 38;
const AUDIT_ARCH_X86_64 = 0xc000003e;
const X32_SYSCALL_BIT = 0x40000000;
/** seccomp_data: nr at 0, arch at 4, the low 32 bits of args[0] at 16 (little-endian). */
const NR = 0;
const ARCH = 4;
const ARG0_LOW = 16;
/** CLONE_NEWTIME, CLONE_NEWNS, CLONE_NEWCGROUP, CLONE_NEWUTS, CLONE_NEWIPC, CLONE_NEWUSER, CLONE_NEWPID, CLONE_NEWNET. */
export const CLONE_NEW_MASK =
  0x00000080 | 0x00020000 | 0x02000000 | 0x04000000 | 0x08000000 | 0x10000000 | 0x20000000 | 0x40000000;
/** AF_UNIX, AF_INET, AF_INET6, AF_NETLINK: the families a shell without network still uses. Every other family: EPERM. */
export const SOCKET_FAMILIES = Object.freeze([1, 2, 10, 16]);
const AF_UNIX = 1;
/** x86_64 numbers (arch/x86/entry/syscalls/syscall_64.tbl). Spec §5 plus RT-23: modules, keys, tracing, io_uring, new namespaces, mounts, cross-process memory. */
export const DENIED_SYSCALLS = Object.freeze({
  ptrace: 101,
  syslog: 103,
  pivot_root: 155,
  acct: 163,
  mount: 165,
  umount2: 166,
  swapon: 167,
  swapoff: 168,
  init_module: 175,
  delete_module: 176,
  quotactl: 179,
  kexec_load: 246,
  add_key: 248,
  request_key: 249,
  keyctl: 250,
  perf_event_open: 298,
  name_to_handle_at: 303,
  open_by_handle_at: 304,
  setns: 308,
  process_vm_readv: 310,
  process_vm_writev: 311,
  kcmp: 312,
  finit_module: 313,
  kexec_file_load: 320,
  bpf: 321,
  userfaultfd: 323,
  io_uring_setup: 425,
  io_uring_enter: 426,
  io_uring_register: 427,
  open_tree: 428,
  move_mount: 429,
  fsopen: 430,
  fsconfig: 431,
  fsmount: 432,
  fspick: 433,
  pidfd_getfd: 438,
  mount_setattr: 442,
  quotactl_fd: 443,
});
/** Judged on their first argument: a family, or namespace flags. clone3 hides its flags in memory: ENOSYS (libc falls back to clone). */
export const ARG_SYSCALLS = Object.freeze({
  socket: 41,
  socketpair: 53,
  clone: 56,
  unshare: 272,
  clone3: 435,
});

export type Insn = readonly [code: number, jt: number, jf: number, k: number];
type Label = "allow" | "eperm" | "enosys" | "socket" | "socketpair" | "flags" | "kill" | null;
type Draft = { code: number; k: number; jt: Label; jf: Label; at?: string };

const jeq = (k: number, jt: Label, jf: Label = null): Draft => ({ code: JEQ_K, k, jt, jf });
const ld = (offset: number): Draft => ({ code: LD_W_ABS, k: offset, jt: null, jf: null });
const ret = (k: number, at?: string): Draft => ({
  code: RET_K,
  k,
  jt: null,
  jf: null,
  ...(at ? { at } : {}),
});

/** Labels resolve to forward offsets; a jump that would leave the program or pass 255 throws (never a silent wrap). */
function assemble(drafts: readonly Draft[]): Insn[] {
  const where = new Map<string, number>();
  drafts.forEach((draft, i) => {
    if (draft.at !== undefined) where.set(draft.at, i);
  });
  const offset = (from: number, label: Label): number => {
    if (label === null) return 0;
    const to = where.get(label);
    if (to === undefined || to <= from || to - from - 1 > 255) throw new RangeError(`bad jump to ${label}`);
    return to - from - 1;
  };
  return drafts.map((d, i) => [d.code, offset(i, d.jt), offset(i, d.jf), d.k >>> 0] as const);
}

export function shellSeccompProgram(): Insn[] {
  const drafts: Draft[] = [
    ld(ARCH),
    jeq(AUDIT_ARCH_X86_64, null, "kill"),
    ld(NR),
    { code: JGE_K, k: X32_SYSCALL_BIT, jt: "kill", jf: null },
    ...Object.values(DENIED_SYSCALLS).map((nr) => jeq(nr, "eperm")),
    jeq(ARG_SYSCALLS.clone3, "enosys"),
    jeq(ARG_SYSCALLS.socket, "socket"),
    jeq(ARG_SYSCALLS.socketpair, "socketpair"),
    jeq(ARG_SYSCALLS.clone, "flags"),
    jeq(ARG_SYSCALLS.unshare, "flags"),
    ret(RET_ALLOW),
    { ...ld(ARG0_LOW), at: "socket" },
    ...SOCKET_FAMILIES.map((family) => jeq(family, "allow")),
    ret(RET_ERRNO | EPERM),
    { ...ld(ARG0_LOW), at: "socketpair" },
    jeq(AF_UNIX, "allow"),
    ret(RET_ERRNO | EPERM),
    { ...ld(ARG0_LOW), at: "flags" },
    { code: JSET_K, k: CLONE_NEW_MASK, jt: "eperm", jf: "allow" },
    ret(RET_ALLOW, "allow"),
    ret(RET_ERRNO | EPERM, "eperm"),
    ret(RET_ERRNO | ENOSYS, "enosys"),
    ret(RET_KILL_PROCESS, "kill"),
  ];
  return assemble(drafts);
}

export function encodeSeccomp(program: readonly Insn[]): Buffer {
  const out = Buffer.alloc(program.length * 8);
  program.forEach(([code, jt, jf, k], i) => {
    out.writeUInt16LE(code, i * 8);
    out.writeUInt8(jt, i * 8 + 2);
    out.writeUInt8(jf, i * 8 + 3);
    out.writeUInt32LE(k >>> 0, i * 8 + 4);
  });
  return out;
}
