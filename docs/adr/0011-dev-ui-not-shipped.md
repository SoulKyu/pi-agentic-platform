# ADR 0011 — /dev/ui is not shipped; unknown routes show the not-found screen

Status: accepted · Date: 2026-10-11 · Spec: DESIGN.md §9.2 ("The page returns 404 in production and sits behind auth") · Owner decision: M3-Q5

## Context

The daemon answers every navigation outside the reserved prefixes with index.html (R78): the SPA, not the server, decides what a
path shows. A literal HTTP 404 for /dev/ui would need a daemon route for a page that only exists in development.

## Decision

The gallery code is compiled only when `import.meta.env.DEV` is true. In a production build, /dev/ui is an unknown path: the app
shows its not-found screen (HTTP 200 from the SPA fallback). In development the gallery is a pane behind the auth gate. M3 has no
standalone gallery build: visual regression, which needed one, is deferred with the browser e2e (owner decision C1).

## Consequences

Nothing of the gallery reaches users; the build-output test checks it. If the owner wants a real 404, the daemon gains one reserved
path; nothing in the web app changes.
