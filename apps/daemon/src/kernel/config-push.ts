import { isHostName } from "./host-name.ts";

/** The M12 settings of `loadConfig` (Task 1): the push subject, the extra push-service hosts and the test switch. */
export interface PushEnv {
  /** `PAP_PUSH_SUBJECT`: an `https:` URL or a `mailto:` address for the VAPID `sub` claim; null derives it (M12R5). */
  readonly pushSubject: string | null;
  /** `PAP_PUSH_EXTRA_HOSTS`: exact host names added to the built-in push-service list, at most 8 (M12R8). */
  readonly pushExtraHosts: readonly string[];
  /** `PAP_TEST_PUSH_LOOPBACK=1`, with the scripted provider: the endpoint validator and the sender accept loopback (M12R19). */
  readonly testPushLoopback: boolean;
}

const MAX_EXTRA_HOSTS = 8;
const MAILTO = /^mailto:[^\s@:/?#]+@[^\s@:/?#]+\.[^\s@:/?#]+$/;

/** Messages are fixed text: the value is never echoed (a mistyped subject or host stays out of a terminal and a crash report). */
export function parsePush(
  env: NodeJS.ProcessEnv,
  scriptSet: boolean,
  refuse: (message: string) => Error,
): PushEnv {
  return {
    pushSubject: parseSubject(env.PAP_PUSH_SUBJECT, refuse),
    pushExtraHosts: parseExtraHosts(env.PAP_PUSH_EXTRA_HOSTS, refuse),
    testPushLoopback: parseLoopback(env.PAP_TEST_PUSH_LOOPBACK, scriptSet, refuse),
  };
}

function parseSubject(raw: string | undefined, refuse: (message: string) => Error): string | null {
  if (raw === undefined || raw === "") return null;
  const refusal = refuse("PAP_PUSH_SUBJECT must be an https:// URL or a mailto: address");
  if (raw.startsWith("mailto:")) {
    if (!MAILTO.test(raw)) throw refusal;
    return raw;
  }
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") throw refusal;
    return raw;
  } catch {
    throw refusal;
  }
}

function parseExtraHosts(raw: string | undefined, refuse: (message: string) => Error): readonly string[] {
  if (raw === undefined || raw === "") return [];
  const refusal = refuse(
    `PAP_PUSH_EXTRA_HOSTS must be at most ${MAX_EXTRA_HOSTS} host names separated by commas (no IP address, scheme, port or path)`,
  );
  const hosts = raw.split(",").map((host) => host.trim().toLowerCase());
  if (hosts.length > MAX_EXTRA_HOSTS) throw refusal;
  for (const host of hosts) if (!isHostName(host)) throw refusal;
  return hosts;
}

function parseLoopback(
  raw: string | undefined,
  scriptSet: boolean,
  refuse: (message: string) => Error,
): boolean {
  if (raw === undefined) return false;
  if (!scriptSet) throw refuse("PAP_TEST_PUSH_LOOPBACK needs PAP_TEST_PROVIDER_SCRIPT");
  if (raw !== "1") throw refuse("PAP_TEST_PUSH_LOOPBACK must be 1");
  return true;
}
