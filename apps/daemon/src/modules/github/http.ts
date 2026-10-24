import type { Context, Hono } from "hono";
import type { HttpCaller } from "../../kernel/http/caller.ts";
import { authorizedPage, createdPage, refusedPage, manifestPage, type Page } from "./pages.ts";
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
    case "authorized":
      return send(c, authorizedPage(outcome.home), 200);
    case "github":
      return send(c, refusedPage("github", outcome.home), 502);
    case "refused":
      return send(c, refusedPage("link", null), 400);
  }
}

/**
 * The GitHub App flow's pages. `new` and `authorize` are entered from pap's own SPA and need the session cookie and
 * `settings:admin`. `created` and `authorized` are entered from github.com, cross site, so the SameSite=Strict cookie
 * does not come: they are matched by the single-use state alone, which is bound to the user who started the flow.
 * All GET: the origin guard does not look at a GET, and nothing here changes anything without that state.
 */
export function mountGithubRoutes(app: Hono, deps: { service: GithubService; httpCaller: HttpCaller }): void {
  const { service, httpCaller } = deps;
  const stateOf = (c: Context): string | null => {
    const state = c.req.query("state");
    return state !== undefined && STATE.test(state) ? state : null;
  };
  app.get("/github/app/new", (c) => {
    const caller = httpCaller(c, "settings:admin");
    if (caller instanceof Response) return caller;
    const state = stateOf(c);
    const start = state === null ? null : service.beginCreate(caller.userId, state);
    if (start === null) return send(c, refusedPage("link", null), 400);
    return send(c, manifestPage(service.webOrigin, start.state, start.manifest), 200);
  });
  app.get("/github/app/authorize", (c) => {
    const caller = httpCaller(c, "settings:admin");
    if (caller instanceof Response) return caller;
    const url = service.reconnectUrl(caller.userId);
    if (url === null) return send(c, refusedPage("link", null), 400);
    c.header("cache-control", "no-store");
    return c.redirect(url, 302);
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
  app.all("/github/*", (c) => c.json({ error: { code: "not_found" } }, 404));
}
