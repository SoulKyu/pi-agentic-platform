import type { Context, Hono } from "hono";
import type { HttpCaller } from "../../kernel/http/caller.ts";
import { authorizedPage, createdPage, exchangedPage, refusedPage, manifestPage, type Page } from "./pages.ts";
import type { CallbackOutcome, GithubService } from "./service.ts";

const STATE = /^[0-9a-f]{32}$/;

function send(c: Context, page: Page, status: 200 | 400 | 502): Response {
  c.set("ownCsp", page.csp);
  c.set("ownCspOnError", true);
  c.header("cache-control", "no-store");
  c.header("referrer-policy", "no-referrer");
  return c.html(page.html, status);
}

function outcomePage(c: Context, outcome: CallbackOutcome): Response {
  switch (outcome.kind) {
    case "created":
      return send(c, createdPage(outcome), 200);
    case "exchanged":
      return send(c, exchangedPage(outcome.ticket, outcome.retry !== true), 200);
    case "authorized":
      return send(c, authorizedPage(outcome.home), 200);
    case "github":
      return send(c, refusedPage("github", outcome.home), 502);
    case "refused":
      return send(c, refusedPage("link", null), 400);
  }
}

/**
 * The GitHub App flow's pages. `new` is entered from pap's own SPA and needs the session cookie and
 * `system:admin`; a sign-in starts from `github.authorizeUrl` only (decision 139). `created` and `authorized` are entered from github.com, cross site, so the SameSite=Strict cookie
 * does not come: `created` is matched by the single-use state alone (owner only); `authorized` binds nothing, it parks the
 * token, and `authorized/finish` stores it only for the session of the user who started the flow.
 * All GET: the origin guard does not look at a GET, and nothing here changes anything without that state.
 */
export function mountGithubRoutes(app: Hono, deps: { service: GithubService; httpCaller: HttpCaller }): void {
  const { service, httpCaller } = deps;
  const stateOf = (c: Context): string | null => {
    const state = c.req.query("state");
    return state !== undefined && STATE.test(state) ? state : null;
  };
  app.get("/github/app/new", (c) => {
    const caller = httpCaller(c, "system:admin");
    if (caller instanceof Response) return caller;
    const state = stateOf(c);
    const start = state === null ? null : service.beginCreate(caller.userId, state);
    if (start === null) return send(c, refusedPage("link", null), 400);
    return send(c, manifestPage(service.webOrigin, start.state, start.manifest), 200);
  });
  app.get("/github/app/created", async (c) => {
    const state = stateOf(c);
    const code = c.req.query("code");
    if (state === null || code === undefined) return send(c, refusedPage("link", null), 400);
    return outcomePage(c, await service.completeCreate(code, state));
  });
  app.get("/github/app/authorized", async (c) => {
    const state = stateOf(c);
    const code = c.req.query("code");
    if (state === null || code === undefined) return send(c, refusedPage("link", null), 400);
    return outcomePage(c, await service.completeAuthorize(code, state));
  });
  // Same site (the page above navigates here), so the SameSite=Strict cookie comes: the browser must be the starting user's.
  app.get("/github/app/authorized/finish", (c) => {
    const ticket = c.req.query("ticket");
    if (ticket === undefined || !STATE.test(ticket)) return send(c, refusedPage("link", null), 400);
    const caller = httpCaller(c, "settings:operate");
    return outcomePage(c, service.finishAuthorize(ticket, caller instanceof Response ? null : caller.userId));
  });
  app.all("/github/*", (c) => c.json({ error: { code: "not_found" } }, 404));
}
