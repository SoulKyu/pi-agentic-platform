/** What lives in pap's home that no file action has a reason to touch (copy of pi-host's `PAP_SENSITIVE`, M8R5). */
export const PAP_SENSITIVE_NAMES = [
  "state.db",
  "state.db-wal",
  "state.db-shm",
  "pap.lock",
  "secrets",
  "backups",
  "exports",
  "fork-tmp",
] as const;

/** Folders whose files run commands later: git hooks and config, Pi settings, agent skills, hook managers, editors. */
export const PROTECTED_SEGMENTS: ReadonlySet<string> = new Set([
  ".git",
  ".pi",
  ".agents",
  ".husky",
  ".vscode",
  ".idea",
  ".zed",
  ".devcontainer",
  ".lefthook",
  ".mise",
]);

export const PROTECTED_BASENAMES: ReadonlySet<string> = new Set([".envrc", ".pre-commit-config.yaml"]);

/** lefthook (`lefthook`, `lefthook-local`) and mise (`mise.toml`, `mise.local.toml`, `mise.<env>.toml`), dotted or not. */
export const HOOK_CONFIG_NAME = /^\.?(lefthook|lefthook-local)\.(ya?ml|toml|json)$|^\.?mise(\.[^.]+)?\.toml$/;

/** Whether an absolute path names a file that can run commands later; segments are NFC-normalised and lower-cased. */
export function isProtectedName(absolutePath: string): boolean {
  const segments = absolutePath
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.normalize("NFC").toLowerCase());
  const last = segments.at(-1) ?? "";
  const inConfigMise = segments.some((segment, i) => segment === "mise" && segments[i - 1] === ".config");
  return (
    segments.some((s) => PROTECTED_SEGMENTS.has(s)) ||
    PROTECTED_BASENAMES.has(last) ||
    HOOK_CONFIG_NAME.test(last) ||
    inConfigMise ||
    (segments.at(-2) === "mise" && last === "config.toml")
  );
}
