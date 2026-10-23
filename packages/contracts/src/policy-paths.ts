/** What an isolated task and a precheck see of the system (owner m16): these folders, read-only, and nothing else. */
export const SYSTEM_FOLDERS = [
  "/usr",
  "/etc",
  "/bin",
  "/sbin",
  "/lib",
  "/lib32",
  "/lib64",
  "/libx32",
  "/opt",
] as const;
