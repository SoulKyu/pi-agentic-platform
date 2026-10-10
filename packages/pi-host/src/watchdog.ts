import { writeFileSync } from "node:fs";

export function applyOomScore(
  score: number,
  env: { platform: NodeJS.Platform; write(path: string, value: string): void } = {
    platform: process.platform,
    write: (path, value) => writeFileSync(path, value),
  },
): boolean {
  if (env.platform !== "linux") return false;
  try {
    env.write("/proc/self/oom_score_adj", String(score));
    return true;
  } catch {
    return false;
  }
}

export function startParentWatchdog(options: {
  initialPpid: number;
  currentPpid?: () => number;
  intervalMs?: number;
  onOrphan(): void;
}): () => void {
  const current = options.currentPpid ?? (() => process.ppid);
  let fired = false;
  const timer = setInterval(() => {
    if (!fired && current() !== options.initialPpid) {
      fired = true;
      options.onOrphan();
    }
  }, options.intervalMs ?? 1000);
  timer.unref();
  return () => clearInterval(timer);
}
