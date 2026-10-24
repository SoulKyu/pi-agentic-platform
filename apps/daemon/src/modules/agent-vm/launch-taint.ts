export interface LaunchTaint {
  /** The launch's proxy let unclean content through: the sessions to taint now; empty after the first call for that launch. */
  mark(launchId: string): readonly string[];
  /**
   * A session started in the launch: the sessions to taint now. `[sessionId]` when the launch is already marked; with `tainted`
   * (a project box's session that is tainted as it starts, spec §4) it marks the launch and answers every session of it.
   */
  join(launchId: string, sessionId: string, tainted?: boolean): readonly string[];
  /** A joined session was tainted by something other than the proxy (a project box, spec §4): marks its launch, as `mark` does. */
  raised(sessionId: string): readonly string[];
  /** The launch is over: forgets its sessions and its mark. */
  ended(launchId: string): void;
}

/**
 * Which sessions share a VM launch and whether the proxy has seen unclean content from it (spec §4). The VM's taint is the
 * daemon's own: every session of the launch is tainted once, and one that starts later in the same launch starts tainted.
 */
export function createLaunchTaint(): LaunchTaint {
  const launches = new Map<string, { marked: boolean; readonly sessions: Set<string> }>();
  const launchOf = new Map<string, string>();
  const of = (launchId: string) => {
    let launch = launches.get(launchId);
    if (launch === undefined) {
      launch = { marked: false, sessions: new Set() };
      launches.set(launchId, launch);
    }
    return launch;
  };
  const mark = (launchId: string): readonly string[] => {
    const launch = of(launchId);
    if (launch.marked) return [];
    launch.marked = true;
    return [...launch.sessions];
  };
  return {
    mark,
    join(launchId, sessionId, tainted = false) {
      const launch = of(launchId);
      launch.sessions.add(sessionId);
      launchOf.set(sessionId, launchId);
      if (launch.marked) return [sessionId];
      return tainted ? mark(launchId) : [];
    },
    raised(sessionId) {
      const launchId = launchOf.get(sessionId);
      return launchId === undefined ? [] : mark(launchId);
    },
    ended(launchId) {
      for (const sessionId of launches.get(launchId)?.sessions ?? []) launchOf.delete(sessionId);
      launches.delete(launchId);
    },
  };
}
