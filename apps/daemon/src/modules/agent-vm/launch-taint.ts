export interface LaunchTaint {
  /** The launch's proxy let unclean content through: the sessions to taint now; empty after the first call for that launch. */
  mark(launchId: string): readonly string[];
  /** A session started in the launch: true when the launch is already marked, so the caller taints the session at once. */
  join(launchId: string, sessionId: string): boolean;
  /** The launch is over: forgets its sessions and its mark. */
  ended(launchId: string): void;
}

/**
 * Which sessions share a VM launch and whether the proxy has seen unclean content from it (spec §4). The VM's taint is the
 * daemon's own: every session of the launch is tainted once, and one that starts later in the same launch starts tainted.
 */
export function createLaunchTaint(): LaunchTaint {
  const launches = new Map<string, { marked: boolean; readonly sessions: Set<string> }>();
  const of = (launchId: string) => {
    let launch = launches.get(launchId);
    if (launch === undefined) {
      launch = { marked: false, sessions: new Set() };
      launches.set(launchId, launch);
    }
    return launch;
  };
  return {
    mark(launchId) {
      const launch = of(launchId);
      if (launch.marked) return [];
      launch.marked = true;
      return [...launch.sessions];
    },
    join(launchId, sessionId) {
      const launch = of(launchId);
      launch.sessions.add(sessionId);
      return launch.marked;
    },
    ended: (launchId) => void launches.delete(launchId),
  };
}
