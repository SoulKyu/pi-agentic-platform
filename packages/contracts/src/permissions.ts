export const DOMAINS = [
  "system",
  "auth",
  "sessions",
  "policy",
  "settings",
  "audit",
  "files",
  "vcs",
  "terminal",
  "pi",
  "lanes",
  "automation",
  "usage",
  "inbox",
] as const;
export const LEVELS = ["read", "operate", "admin"] as const;
export type Domain = (typeof DOMAINS)[number];
export type Level = (typeof LEVELS)[number];
export type Permission = `${Domain}:${Level}`;

export const ALL_PERMISSIONS: readonly Permission[] = DOMAINS.flatMap((domain) =>
  LEVELS.map((level): Permission => `${domain}:${level}`),
);
