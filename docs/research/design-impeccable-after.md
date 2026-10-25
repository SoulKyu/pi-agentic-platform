# Design pass after the impeccable audit: after-values

Measured in a throwaway worktree detached at the lot's head before the final fix wave (`13141c65` plus the lot). Journeys restored from audit section 8 under their audit names (`j16-screens`, `j16-term`, `j16-extra`, `j06-screens`, `j06-extra`, plus `shots-lib.ts`, `shots-seed.ts`), run in the container under the flock: 8 passed, 3 skipped (the in-page detector tests, see below). Captures and `measure.jsonl`: `shots-after/` (69 PNG, same names as the audit's `shots/`).

Detector: `impeccable-linux-x64` 0.1.17 fetched from the release; SHA-256 `44c0d601...ab629` equals the sidecar and the audit's value. Ran only under `bwrap --unshare-all` with `DO_NOT_TRACK=1 IMPECCABLE_NO_TELEMETRY=1`, on copies of `apps/web/src`, `packages/ui/src`, `DESIGN.md` and the built CSS/HTML. The in-page script (`detect-antipatterns-browser.js`) was not run: it comes from a repo clone (a second network fetch, not allowed), so the three DOM-detector tests skipped and no DOM snapshot scan exists.

Adaptations to the audit's code: (1) file names: the e2e runner refuses a `shots-j06-*` file, so the journeys keep the audit's `j16-*`/`j06-*` names; (2) `j16-screens`: `page.waitForTimeout(600)` before the minimap measure (to rule out a transition), uncommitted; (3) the missing-session step's `locator("main, body")` now matches two elements (strict mode), so that step errors, but `j16-extra` captures the same screen with `#pane-host` and wrote `session-missing-1440-night.png`.

| Check | v2 | Expected | Measured now | Result |
|---|---|---|---|---|
| `undersized-ui-text` at 10.5 px | 366 | 0; labels compute 11 px | detector on sources and built CSS: 0 hits of the rule; computed sizes over 1020 measured elements: 838 at 11 px, none under 11 | pass |
| Tab title tracking | 0.12em | 0.08em | 0.88px at 11px = 0.08em | pass |
| Agent prose, characters per line at 1440 | 202 | <= 90 (72ch in Manrope) | audit method on its seeded paragraph: max 97, median 94 (lines 78+13, 94, 97, 56). The committed J16 paragraph (no code, wider glyphs) passes at <= 90 | FAIL (audit method) |
| `innerWidth` at 320 (home, session, Settings, Tasks, trigger editor) | 347 | 320 | scrollWidth = innerWidth = 320 on all five (also 390: 390) | pass |
| Day ring on surface-2 | 2.99 | 4.35 | outline #c2410c on #eeebe4 = 4.35 | pass |
| Day placeholder | 3.31 | 5.55 on bg, 5.84 on surface | `::placeholder` = `--text-muted` #6b645a, opacity 1: 5.55 on #faf9f6, 5.84 on #fff (computed from the rule; the journey's own probe returned null) | pass |
| Terminal | selection 1.19; blue = cyan; bright = normal; Day black 2.43 | 8.98 text on selection; 16 distinct colours; black 5.55 | selection rgb(69,58,103) with text #f2effa = 9.01; 16 distinct colours (Night); Day black rgb(107,100,90) on #faf9f6 = 5.55 | pass |
| Minimap and bottom nav current | 1.08; text colour only | agent rule; agent bar | bottom nav: 2px top bar rgb(167,139,250), text fg: pass. Minimap: current turn has surface background only; computed border-left transparent and colour muted, still so after 600 ms | Fixed in the final fix wave: exclusive class branches, asserted by `current-states.test.tsx` (the current button holds neither `border-transparent` nor `text-muted`). Not measured again in a browser | fixed, unit-tested |
| Settings column widths | 520 to 1136 px | <= 768 px for column sections | Automation and GitHub column 768; Appearance, MCP, Models: header and wrapper 1136, widest control 768 / 768 / 355 | pass |
| First Tab stop | the wordmark; 10 stops to the tab | Skip to content | fresh page load (committed `j16-layout`, passes): skip link first, Enter focuses `#pane-host`. Audit method on home: "Launch" (the home field holds focus on load, `ProjectHome.tsx:70`, so Tab leaves it for Launch). Tab-order dump starts after a click at (5,5): 10 stops to the active tab | pass (j16-layout) |
| Missing session | "Not found." in pink | EmptyState | "This session no longer exists", explanation, two buttons, dashed EmptyState frame, no pink | pass |
| MCP loading flash | 29 ms | nothing before 100 ms | client navigation: click at 617 ms, first fallback at 745 ms (128 ms), gone at 943 ms | pass |
| Edit row | raw JSON | `README.md · +4 −0`; diff when opened | row text "edit README.md · +4 −0 Done"; opened card shows the diff (`edit-tool-open-1440-night.png`) | pass |

Count at measurement: 11 pass, 2 fail (13 rows). After the final fix wave: the minimap row is fixed and unit-tested; the line-length row is the owner's call (ruling R17).

## Findings that still show

- Agent prose line length: 97 characters max, median 94, on the audit's seeded paragraph (202 before). Capture `session-1440-night.png`, `prose` rows `1440-night`, `1440-day`, `1440-hc`. The measure stays at 72ch (the owner's D3 value); tightening it to about 66ch would reach 90. The owner decides.
- First Tab on the home page lands on "Launch", not the skip link, because the launch field is focused on load. A fresh Tab from the page start reaches the skip link (`j16-layout`). Accepted.
- Settings Appearance, MCP and Models keep a 1136 px header and wrapper; only their controls stop at 768 px. Accepted (split sections).
- `side-tab`: 2 detector hits in `apps/web/src/side-tab.test.ts` (the guard's own fixtures) and 1 in the built CSS (the `border-l-2` utility).

Fixed since the measurement, by the final fix wave:

- Minimap current turn: agent rule and `text-fg` now apply (one class set per state).
- Settings > MCP loading line: "Loading servers..." now ends in the ellipsis character, and the catalog guard refuses every value ending in three dots.

## How it was measured

- Journeys `j16-screens`, `j16-term`, `j16-extra`, `j06-screens`, `j06-extra` ran in the e2e container under the heavy-gate flock (8 passed, 3 skipped), writing 69 captures and 149 records of computed style and geometry.
- The in-page detector script was not run (it comes from a repository clone, a second network fetch), so the three DOM-detector tests skipped and no DOM snapshot scan exists.
- Computed values (type sizes, tracking, contrast pairs, outline colours, widths) come from `getComputedStyle` and `getBoundingClientRect` in Chromium; contrast ratios are computed from those colours.

## Detector status

`impeccable-linux-x64` 0.1.17, SHA-256 equal to the audit's. Run only under `bwrap --unshare-all` on copies of the sources and the built CSS. `undersized-ui-text`: 0 hits (v2: 366). `side-tab`: see above. No after-run of the in-page script.
