const COUNT = "GIT_CONFIG_COUNT";
/** git's own limit is far higher; a count past this is not one the daemon or the owner wrote. */
const MAX_COUNT = 1000;

/**
 * M7 MC18: every git the agent runs gets `safe.bareRepository=explicit` as command-scope config, so a folder that only
 * looks like a bare repository (HEAD, objects, refs, config written by plain file writes) is never discovered. Appended
 * to `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>`, keeping the entries already there; the last
 * entry wins, so this one holds. A count that is not a plain number throws: the worker does not start (fails closed).
 */
export function pinBareRepositoryExplicit(env: NodeJS.ProcessEnv): void {
  const raw = env[COUNT];
  if (raw !== undefined && !/^(?:0|[1-9]\d{0,3})$/.test(raw))
    throw new Error(`${COUNT} is not a plain number`);
  const count = raw === undefined ? 0 : Number(raw);
  if (count > MAX_COUNT) throw new Error(`${COUNT} is too large`);
  env[`GIT_CONFIG_KEY_${count}`] = "safe.bareRepository";
  env[`GIT_CONFIG_VALUE_${count}`] = "explicit";
  env[COUNT] = String(count + 1);
}
