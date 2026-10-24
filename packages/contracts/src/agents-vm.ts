import { z } from "zod";
import { PackagePicks } from "./agents-resources.ts";
import { BoxRef } from "./box-ref.ts";
import { BoxOp, BoxOpError } from "./boxes.ts";
import { FILE_CHUNK_B64, FILE_CHUNK_BYTES } from "./file-chunk.ts";
import { AbsolutePath, LINE_HIDDEN } from "./text-rules.ts";

const FileId = z.string().regex(/^[0-9a-f]{32}$/);

/** Spec §4, decision 107. Fixed in v1; `pap vm setup` writes the same values. */
export const AGENT_NET = Object.freeze({
  network: "pap-agents",
  bridge: "pap0",
  subnet: "10.213.0.0/24",
  host: "10.213.0.1",
  gatewayPort: 7841,
  relayPort: 7842,
  proxyPort: 7843,
});
/** Where host-local keeps its reservations (the conflist's `dataDir`, under /run: no VM outlives a reboot); one folder per network below it. */
export const CNI_IPAM_DIR = "/run/pap-vm/cni-ipam";
export const AGENT_VM_PROTOCOL = 2;
/** The gateway frame bound. `frames.ts` has the WebSocket's `MAX_FRAME_BYTES` (1 MiB): a different bound. */
export const AGENT_VM_MAX_FRAME_BYTES = 4 * 1024 * 1024;
/** RT-27: what a connection may send before its hello is accepted, and the gateway's other bounds. */
export const HELLO_MAX_BYTES = 4096;
export const HELLO_TIMEOUT_MS = 10_000;
/** RT-35: how long a started VM's guest has to say hello (a cold Kata start), apart from each connection's hello timeout. */
export const GUEST_BOOT_TIMEOUT_MS = 60_000;
export const GATEWAY_LIMITS = Object.freeze({
  pendingTotal: 16,
  pendingPerSource: 4,
  windowMs: 10_000,
  windowBytes: 64 * 1024 * 1024,
  writeBacklogBytes: 16 * 1024 * 1024,
});
/** R1: raw bytes per `session_append`; base64 makes it 4/3 larger and still under a frame. */
export const SESSION_CHUNK_BYTES = 2 * 1024 * 1024;
export const SESSION_CHUNK_B64 = Math.ceil(SESSION_CHUNK_BYTES / 3) * 4;
export const MAX_SESSION_LINE_BYTES = 32 * 1024 * 1024;
export { FILE_CHUNK_B64, FILE_CHUNK_BYTES };
export const GATEWAY_PING_MS = 15_000;
export const GATEWAY_PING_MISSES = 3;
export const IMAGE_TAG = /^pap-agent-(base|profile|agent)-[0-9a-f]{64}$/;

const hex = (bytes: number) => z.string().regex(new RegExp(`^[0-9a-f]{${bytes * 2}}$`));
export const LaunchId = hex(16);
export const SlotId = hex(16);
export const GatewayToken = hex(32);
/** RT-03, R13: the launch's key for the relay, presented by the worker as its provider credential. Never logged. */
export const RelayKey = hex(32);
/** Canonical base64: whole groups of four, padded only at the end. */
const Base64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** A Pi entry id as the VM names it: one visible line. */
const EntryId = z
  .string()
  .min(1)
  .max(128)
  .refine((text) => !LINE_HIDDEN.test(text), "visible text on one line");
/** A Pi session file's name in the VM's sessions folder: the mirror keeps the same name (R23, R28). */
export const SessionFileName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.jsonl$/);

/** Where things are inside the VM (`/agent/...` under Kata, a temp folder under the process backend). */
export const VmLayout = z
  .object({
    root: AbsolutePath,
    home: AbsolutePath,
    knowledge: AbsolutePath,
    inbox: AbsolutePath,
    pi: AbsolutePath,
    sessions: AbsolutePath,
    /** R28 (RT-07): Pi's writable agent folder on the disk, seeded by the guest from `imageAgentDir` at each start. */
    piAgentDir: AbsolutePath,
    imageAgentDir: AbsolutePath,
    shellOverlay: AbsolutePath,
    /** A project box only (spec boxes): the project folder, which is the session's cwd and own folder. An agent's layout has none. */
    project: AbsolutePath.optional(),
  })
  .strict();
export type VmLayout = z.infer<typeof VmLayout>;

/** The `vm` field of `init` for a worker in a VM. `init` is never logged: it carries the relay key. */
export const VmInit = z
  .object({
    layout: VmLayout,
    bwrap: AbsolutePath,
    relayKey: RelayKey,
    /** This worker's slot: its shell's own overlay (R27). */
    slot: SlotId,
    /** R27: what T0a showed bwrap can do with the image root as guest root. */
    rootView: z.enum(["overlay", "read-only"]),
  })
  .strict();
export type VmInit = z.infer<typeof VmInit>;

const helloBase = {
  type: z.literal("hello"),
  box: BoxRef,
  launchId: LaunchId,
  token: GatewayToken,
  protocol: z.literal(AGENT_VM_PROTOCOL),
  imageTag: z.string().regex(IMAGE_TAG),
};
export const GuestHello = z.object({ ...helloBase, role: z.literal("guest") }).strict();
export const WorkerHello = z
  .object({
    ...helloBase,
    role: z.literal("worker"),
    slot: SlotId,
    /** The file the guest named at spawn, as the VM has it now (spec §11). */
    session: z
      .object({
        file: SessionFileName.nullable(),
        lastEntryId: EntryId.nullable(),
        size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
  })
  .strict();
export const Hello = z.discriminatedUnion("role", [GuestHello, WorkerHello]);
export type Hello = z.infer<typeof Hello>;

/** Transport-level liveness, handled by both socket ends and never handed to the protocol layer. */
export const TransportPing = z.object({ type: z.literal("ping") }).strict();
export const TransportPong = z.object({ type: z.literal("pong") }).strict();

/**
 * Environment the daemon asks the guest to add to a worker. The guest applies it through a closed allowlist (ADR 0080:
 * `IS_SANDBOX=1`, `CLAUDE_CONFIG_DIR` under the layout's home) and drops and logs anything else, so the schema only bounds it.
 */
export const WorkerExtraEnv = z
  .record(z.string().max(64), z.string().max(4096))
  .refine((env) => Object.keys(env).length <= 16);

/**
 * Daemon to guest. `packages`: the agent's picks, written into the worker's Pi settings before the spawn (RT-29). `env`:
 * the extra environment of a claude-bridge agent's worker (ADR 0080), absent for every other agent.
 */
export const GuestCommand = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("spawn"),
      slot: SlotId,
      sessionFile: AbsolutePath.nullable(),
      packages: PackagePicks,
      env: WorkerExtraEnv.optional(),
    })
    .strict(),
  z.object({ type: z.literal("signal"), slot: SlotId, signal: z.enum(["SIGTERM", "SIGKILL"]) }).strict(),
  z.object({ type: z.literal("shutdown") }).strict(),
  /** One guest operation of a project box (spec boxes); `id` correlates the `op_result`. */
  z.object({ type: z.literal("op"), id: FileId, op: BoxOp }).strict(),
]);
export type GuestCommand = z.infer<typeof GuestCommand>;
/** Guest to daemon. */
export const GuestReport = z.discriminatedUnion("type", [
  z.object({ type: z.literal("spawned"), slot: SlotId }).strict(),
  z
    .object({
      type: z.literal("exited"),
      slot: SlotId,
      code: z.number().int().nullable(),
      signal: z
        .string()
        .regex(/^SIG[A-Z0-9]{1,13}$/)
        .nullable(),
      tail: z.string().max(8192),
    })
    .strict(),
  /** The answer to an `op`: the value is checked against the op's result schema by the daemon, never trusted. */
  z.discriminatedUnion("ok", [
    z.object({ type: z.literal("op_result"), id: FileId, ok: z.literal(true), value: z.unknown() }).strict(),
    z.object({ type: z.literal("op_result"), id: FileId, ok: z.literal(false), code: BoxOpError }).strict(),
  ]),
]);
export type GuestReport = z.infer<typeof GuestReport>;

/** Worker to daemon (R1): the bytes Pi wrote to `file` from `offset`; `replace` starts that mirror over at offset 0. */
export const SessionAppend = z
  .object({
    type: z.literal("session_append"),
    file: SessionFileName,
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    data: z.string().max(SESSION_CHUNK_B64).regex(Base64),
    replace: z.boolean(),
  })
  .strict();
export type SessionAppend = z.infer<typeof SessionAppend>;
/**
 * Daemon to worker (spec §11, RT-39): send the file again from `fromOffset` when the entry ending there is `lastEntryId`
 * (the mirror is a prefix of the file), else from 0 with `replace`. `fromOffset: 0` always resends the whole file.
 */
export const SessionResync = z
  .object({
    type: z.literal("session_resync"),
    fromOffset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    lastEntryId: EntryId.nullable(),
  })
  .strict();
/** Daemon to worker: one chunk of an attachment for the inbox (R33); chunks of one `id` come in order, `last` ends it. */
export const FilePut = z
  .object({
    type: z.literal("file_put"),
    id: FileId,
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    data: z.string().max(FILE_CHUNK_B64).regex(Base64),
    last: z.boolean(),
  })
  .strict();
export const FilePutResult = z
  .object({
    type: z.literal("file_put_result"),
    id: FileId,
    ok: z.boolean(),
    code: z.enum(["exists", "too_large", "order", "write_failed"]).optional(),
  })
  .strict();
/**
 * Daemon to worker (sub-project 2, spec 7): one chunk of an imported file for the agent's home. `path` is checked again by the
 * worker (`AgentFilePath`), never trusted from the wire. Chunks of one `id` come in order, `last` ends it.
 */
export const HomePut = z
  .object({
    type: z.literal("home_put"),
    id: FileId,
    path: z.string().max(512),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    data: z.string().max(FILE_CHUNK_B64).regex(Base64),
    last: z.boolean(),
  })
  .strict();
/** Daemon to worker: the owner removed the file; a path that is not there is already removed. */
export const HomeRemove = z
  .object({ type: z.literal("home_remove"), id: FileId, path: z.string().max(512) })
  .strict();
export const HomeResult = z
  .object({
    type: z.literal("home_result"),
    id: FileId,
    ok: z.boolean(),
    code: z.enum(["too_large", "order", "write_failed"]).optional(),
  })
  .strict();
