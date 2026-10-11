import { readdirSync, readFileSync } from "node:fs";

// Linux only (CI and the dev machines are): /proc tells who runs, who descends from whom, and under which HOME.
const procStat = (pid: number): string | null => {
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
};
export function cmdlineOf(pid: number): string[] {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
  } catch {
    return [];
  }
}
export function running(pid: number): boolean {
  const stat = procStat(pid);
  // A zombie is dead, only not yet reaped.
  return stat !== null && stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
}
export function descendantsOf(root: number): number[] {
  const parentOf = new Map<number, number>();
  for (const entry of readdirSync("/proc")) {
    const pid = Number(entry);
    const stat = Number.isInteger(pid) ? procStat(pid) : null;
    if (stat) parentOf.set(pid, Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]));
  }
  const found = new Set<number>();
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, parent] of parentOf) {
      if ((parent === root || found.has(parent)) && !found.has(pid)) {
        found.add(pid);
        grew = true;
      }
    }
  }
  return [...found];
}
// Processes started under this run's HOME, wherever they sit in the tree now: the orphans a clean stop must not leave.
export function runningUnder(userHome: string): number[] {
  const needle = Buffer.from(`HOME=${userHome}\0`);
  return readdirSync("/proc")
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid !== process.pid && running(pid))
    .filter((pid) => {
      try {
        return readFileSync(`/proc/${pid}/environ`).includes(needle);
      } catch {
        return false;
      }
    });
}
