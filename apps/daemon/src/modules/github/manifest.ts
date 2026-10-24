import { randomBytes } from "node:crypto";

/** One switch for the App's visibility: `true` lets other accounts install it (members, M14). */
export const APP_PUBLIC = false;

/** The repository permissions the App declares; box tokens ask for less (see `BOX_PERMISSIONS`). */
export const APP_PERMISSIONS = Object.freeze({
  contents: "write",
  pull_requests: "write",
  issues: "read",
  checks: "read",
  actions: "read",
  metadata: "read",
  administration: "write",
});

const NAME_MAX = 34; // GitHub's limit for an App name

/** `pap-<host label>-<4 hex>`: the label is the host's first name part, lowercase letters, digits and dashes. */
export function appName(hostLabel: string): string {
  const suffix = randomBytes(2).toString("hex");
  const label = hostLabel
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const room = NAME_MAX - "pap--".length - suffix.length;
  return `pap-${label.slice(0, room).replace(/-+$/, "") || "host"}-${suffix}`;
}

/** The manifest GitHub's manifest flow takes, as the JSON text the browser posts. `origin` is where the owner reaches pap. */
export function buildManifest(origin: string, name: string): string {
  return JSON.stringify({
    name,
    url: origin,
    hook_attributes: { url: origin, active: false },
    redirect_url: `${origin}/github/app/created`,
    callback_urls: [`${origin}/github/app/authorized`],
    request_oauth_on_install: true,
    public: APP_PUBLIC,
    default_permissions: APP_PERMISSIONS,
  });
}
