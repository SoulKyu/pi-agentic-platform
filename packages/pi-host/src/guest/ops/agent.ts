import { type BoxOp } from "@pap/contracts/pi-host";
import { createGuestOps, type GuestOps } from "./index.ts";
import { OpError, opErrorOf, segmentsOf } from "./paths.ts";

const HIDDEN = new Set([".pi", "lost+found"]);

const isHidden = (root: string, path: string): boolean => {
  const first = segmentsOf(root, path)[0];
  return first !== undefined && HIDDEN.has(first);
};

/**
 * The guest's operations in an agent VM: the file operations over the agent's folder, with `.pi` and `lost+found` out of
 * sight, and nothing of a project box (git, knowledge, project config, GitHub), which answers `not_found`.
 */
export function createAgentGuestOps(root: string, now: () => number): GuestOps {
  const inner = createGuestOps(root, now, undefined, [...HIDDEN]);

  return async (op: BoxOp) => {
    try {
      switch (op.name) {
        case "fs.list":
        case "fs.read":
        case "fs.write":
        case "fs.put":
        case "fs.get": {
          if (isHidden(root, op.path)) throw new OpError("not_found");
          const answer = await inner(op);
          if (op.name === "fs.list" && answer.ok && segmentsOf(root, op.path).length === 0) {
            const value = answer.value as { entries: { name: string }[] };
            return {
              ok: true,
              value: { ...value, entries: value.entries.filter((entry) => !HIDDEN.has(entry.name)) },
            };
          }
          return answer;
        }
        case "fs.search": {
          const answer = await inner(op);
          if (!answer.ok) return answer;
          const value = answer.value as { paths: string[] };
          return {
            ok: true,
            value: { ...value, paths: value.paths.filter((path) => !HIDDEN.has(path.split("/")[0] ?? "")) },
          };
        }
        default:
          throw new OpError("not_found");
      }
    } catch (error) {
      return { ok: false, code: opErrorOf(error).code };
    }
  };
}
