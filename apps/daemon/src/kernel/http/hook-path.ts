/** `POST /hooks/<trigger id>`: the id is a v4 UUID in lower case; anything else is not a hook request. */
export const HOOK_PATH = /^\/hooks\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

/**
 * The one request the Origin check lets through: a server (Alertmanager, Grafana, GitHub) sends no browser Origin. It lives
 * in the kernel because the Origin guard is the kernel's; the automation module re-exports it.
 */
export const isHookRequest = (method: string, path: string): boolean =>
  method === "POST" && HOOK_PATH.test(path);
