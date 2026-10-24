import { createHash } from "node:crypto";

const escapes: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
/** Every value put in a page goes through here. */
export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (ch) => escapes[ch] ?? ch);

const STYLE =
  "body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem}a,button{display:inline-block;min-height:44px;line-height:44px;padding:0 1rem}";
const AUTO_SUBMIT = "document.forms[0].submit()";
const hash = (text: string): string => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

/** The pages' own policy: nothing loads, no form goes anywhere but `formAction` (none by default). */
function csp(extra: { script?: boolean; formAction?: string }): string {
  return [
    "default-src 'none'",
    `style-src ${hash(STYLE)}`,
    extra.script ? `script-src ${hash(AUTO_SUBMIT)}` : "script-src 'none'",
    `form-action ${extra.formAction ?? "'none'"}`,
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export interface Page {
  readonly html: string;
  readonly csp: string;
}

const shell = (title: string, body: string, script: boolean): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><h1>${escapeHtml(title)}</h1>${body}${script ? `<script>${AUTO_SUBMIT}</script>` : ""}</body></html>`;

/** Posts the manifest to GitHub at once (a button for a browser without scripts). */
export function manifestPage(webOrigin: string, state: string, manifest: string): Page {
  const action = `${webOrigin}/settings/apps/new?state=${encodeURIComponent(state)}`;
  const body = `<p>Sending the App to GitHub.</p><form method="post" action="${escapeHtml(action)}"><input type="hidden" name="manifest" value="${escapeHtml(manifest)}"><button type="submit">Continue to GitHub</button></form>`;
  return {
    html: shell("Create the GitHub App", body, true),
    csp: csp({ script: true, formAction: webOrigin }),
  };
}

export function createdPage(app: {
  slug: string;
  permissionsUrl: string;
  installUrl: string;
  installationsUrl: string;
  home: string;
}): Page {
  const body = `<p>The App <strong>${escapeHtml(app.slug)}</strong> exists. Two steps remain.</p><ol><li><a href="${escapeHtml(app.permissionsUrl)}">Review its permissions on GitHub</a>: add &ldquo;SSH signing keys: Read and write&rdquo;.</li><li><a href="${escapeHtml(app.installUrl)}">Install it</a> on the repositories pap may reach.</li></ol><p>When you change its permissions later, accept them on <a href="${escapeHtml(app.installationsUrl)}">your installations</a>.</p><p><a href="${escapeHtml(app.home)}">Back to pap</a></p>`;
  return { html: shell("GitHub App created", body, false), csp: csp({}) };
}

export function authorizedPage(home: string): Page {
  return {
    html: shell(
      "GitHub connected",
      `<p>pap is connected to GitHub.</p><p><a href="${escapeHtml(home)}">Back to pap</a></p>`,
      false,
    ),
    csp: csp({}),
  };
}

export function refusedPage(reason: "link" | "github", home: string | null): Page {
  const text =
    reason === "link"
      ? "This link is not valid, or it expired. Start again from Settings, GitHub, in pap."
      : "GitHub did not complete the request. Start again from Settings, GitHub, in pap.";
  const back = home === null ? "" : `<p><a href="${escapeHtml(home)}">Back to pap</a></p>`;
  return { html: shell("GitHub", `<p>${escapeHtml(text)}</p>${back}`, false), csp: csp({}) };
}
