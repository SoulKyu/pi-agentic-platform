// Routes and WebSocket live under these prefixes: a miss is a 404, never index.html, so a typo in an
// API path cannot be masked by the SPA fallback (R78).
const RESERVED_PREFIXES = [
  "/auth",
  "/api",
  "/files",
  "/upload",
  "/hooks",
  "/metrics",
  "/ws",
  "/fonts",
  "/github",
];
export function isReserved(path: string): boolean {
  const forms = [path];
  try {
    forms.push(decodeURIComponent(path));
  } catch {
    // An undecodable path is refused by the static handler anyway.
  }
  return forms.some((form) =>
    RESERVED_PREFIXES.some((prefix) => form === prefix || form.startsWith(`${prefix}/`)),
  );
}
