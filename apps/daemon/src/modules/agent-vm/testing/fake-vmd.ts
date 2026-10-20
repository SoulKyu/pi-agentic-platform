import type { VmdRequest } from "@pap/contracts";
import { type VmdClient, VmdError, type VmdErrorCode } from "../index.ts";

/** What a test sees of a request: the op and its fields, in the order the client sent them. */
export type Seen = VmdRequest;

export interface FakeVmd extends VmdClient {
  readonly requests: Seen[];
  /** The op names in order (`vm.start`, `disk.create`...). */
  ops(): string[];
  /** Requests of one op. */
  of<Op extends VmdRequest["op"]>(op: Op): Array<Extract<VmdRequest, { op: Op }>>;
  /** Tags `image.list` answers (what has been built). */
  readonly images: Set<string>;
  /** Agent disks pap-vmd holds, by agent id, in MiB. */
  readonly disks: Map<string, number>;
  /** VMs pap-vmd runs: `agentId` or `agentId/taskKey`. */
  readonly running: Set<string>;
  /** The next request of this op answers this error (once). */
  failNext(op: VmdRequest["op"], code: VmdErrorCode): void;
  /** Replaces the answer of an op (e.g. to hold it open). */
  handle(op: VmdRequest["op"], handler: (request: Seen) => unknown): void;
  /** The address `vm.start` answers (VM_IPV4 shape). */
  address: string;
  bridge: boolean;
}

/** A pap-vmd in memory, with the refusals the real one makes (conflict on a duplicate disk, a grow under a running VM). */
export function createFakeVmd(): FakeVmd {
  const requests: Seen[] = [];
  const failures: Array<{ op: string; code: VmdErrorCode }> = [];
  const handlers = new Map<string, (request: Seen) => unknown>();
  const fake: FakeVmd = {
    requests,
    images: new Set(),
    disks: new Map(),
    running: new Set(),
    address: "10.213.0.2",
    bridge: true,
    ops: () => requests.map((request) => request.op),
    of: (op) => requests.filter((request) => request.op === op) as never,
    failNext: (op, code) => void failures.push({ op, code }),
    handle: (op, handler) => void handlers.set(op, handler),
    async request(request) {
      requests.push(request);
      const index = failures.findIndex((one) => one.op === request.op);
      if (index !== -1) throw new VmdError((failures.splice(index, 1)[0] as { code: VmdErrorCode }).code);
      const custom = handlers.get(request.op);
      if (custom) return custom(request);
      return answer(request);
    },
  };
  const key = (agentId: string, taskKey: string | null): string =>
    taskKey === null ? agentId : `${agentId}/${taskKey}`;
  const runningOf = (agentId: string): boolean =>
    [...fake.running].some((name) => name === agentId || name.startsWith(`${agentId}/`));
  function answer(request: Seen): unknown {
    switch (request.op) {
      case "image.list":
        return { tags: [...fake.images] };
      case "image.build":
        fake.images.add(request.tag);
        return { tag: request.tag };
      case "disk.create":
        if (fake.disks.has(request.agentId)) throw new VmdError("conflict");
        fake.disks.set(request.agentId, request.diskMb);
        return { diskMb: request.diskMb };
      case "disk.grow": {
        const have = fake.disks.get(request.agentId);
        if (have === undefined) throw new VmdError("not_found");
        if (runningOf(request.agentId)) throw new VmdError("conflict");
        if (request.diskMb < have) throw new VmdError("bad_request");
        fake.disks.set(request.agentId, request.diskMb);
        return { diskMb: request.diskMb };
      }
      case "disk.delete":
        if (request.taskKey === null) {
          if (!fake.disks.has(request.agentId)) throw new VmdError("not_found");
          if (runningOf(request.agentId)) throw new VmdError("conflict");
          fake.disks.delete(request.agentId);
        }
        return { deleted: true };
      case "vm.start": {
        if (request.kind === "thread" && !fake.disks.has(request.agentId)) throw new VmdError("not_found");
        fake.running.add(key(request.agentId, request.taskKey));
        return { address: fake.address };
      }
      case "vm.stop":
        fake.running.delete(key(request.agentId, request.taskKey));
        return { stopped: true };
      case "vm.list":
        return {
          vms: [...fake.running].map((name) => {
            const [agentId = "", taskKey = null] = name.split("/");
            return { agentId, taskKey, state: "running" };
          }),
        };
      case "trash.purge":
        return { removed: 0 };
      case "vmd.health":
        return { version: "0.0.0", ruleset: true, bridge: fake.bridge, stateFreeMb: 100_000 };
      default:
        throw new VmdError("bad_request");
    }
  }
  return fake;
}
