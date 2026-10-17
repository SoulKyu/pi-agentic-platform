/** True when this process is inside the unit it is about to stop: its cgroup names the unit, or an ancestor is the daemon (a shell in pap's own web terminal). */
export function runsInsideDaemon(input: {
  readonly cgroupText: string;
  readonly unit: string;
  readonly ancestorPids: readonly number[];
  readonly daemonPid: number | null;
}): boolean {
  const inUnit = input.cgroupText.split("\n").some((line) => line.split("/").includes(input.unit));
  return inUnit || (input.daemonPid !== null && input.ancestorPids.includes(input.daemonPid));
}

/** The parent chain of `start` from /proc, at most 64 hops: field 4 of /proc/<pid>/stat. `readStat` is injected in tests. */
export function ancestorPids(readStat: (pid: number) => string | null, start = process.pid): number[] {
  const chain: number[] = [];
  let pid = start;
  for (let hops = 0; hops < 64 && pid > 1; hops++) {
    const stat = readStat(pid);
    const parent = stat === null ? NaN : Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    if (!Number.isInteger(parent) || parent <= 0) break;
    chain.push(parent);
    pid = parent;
  }
  return chain;
}
