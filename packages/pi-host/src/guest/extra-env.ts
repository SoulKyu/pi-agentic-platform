/** The only variables a spawn command may add to a worker's environment (ADR 0080). */
const SANDBOX_KEY = "IS_SANDBOX";
const CONFIG_KEY = "CLAUDE_CONFIG_DIR";

const underHome = (path: string, home: string): boolean => {
  const root = home.replace(/\/+$/, "");
  return path.startsWith(`${root}/`) && path.length > root.length + 1 && !path.split("/").includes("..");
};

/**
 * Closed allowlist for the extra environment a spawn command carries: `IS_SANDBOX` with the value `1`, and `CLAUDE_CONFIG_DIR`
 * as an absolute path under the layout's home without `..`. Any other key or value is dropped and logged by key, never by value.
 */
export function allowedExtraEnv(
  asked: Readonly<Record<string, string>> | undefined,
  home: string,
  log: (line: string) => void,
): Record<string, string> {
  const applied: Record<string, string> = {};
  for (const [key, value] of Object.entries(asked ?? {})) {
    const ok = (key === SANDBOX_KEY && value === "1") || (key === CONFIG_KEY && underHome(value, home));
    if (ok) applied[key] = value;
    else log(`refused the extra environment variable ${key.slice(0, 64)} of a spawn`);
  }
  return applied;
}
