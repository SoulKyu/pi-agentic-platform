# web — agent notes

Code: `apps/web/src/` and `packages/ui/src/`. Specs: DESIGN.md, spec C §7; ADRs 0010 to 0012.

## Shell (`routes/shell/`, `features/workspace/`)

- The URL names the active item. `PANE_RENDERERS` (`pane-renderers.tsx`) maps an item kind to its screen; only the active tab of a pane is mounted.
- The workspace (tabs, split) persists in `localStorage` as `pap.workspace.v1`; a damaged value is dropped, not repaired.
- Lazy screens go through `lib/lazy.tsx` (`LazyBoundary`): a chunk that fails to load renders nothing and reports `lazy_chunk_failed`; the shell stays standing.
- Phone: `MobileShell` (bottom nav, one pane, sheets) replaces the rail layout under the breakpoint; it is in the initial bundle.

## Appearance (`features/appearance/`)

- Two scopes. Device (`pap.appearance.device.v1`): density, text sizes, motion, chat width; the language is per device too (`pap.locale`). Account (the `settings` module, cached in `pap.appearance.account.v1`): mode, themes, custom themes, fonts, label case, grid, rail position, avatar style, tool detail.
- Account documents sync with compare-and-set (`lib/account-setting.ts`): writes are held until the first load settles, send `baseRevision`, and on `conflict` merge field by field and retry once (R105). A timeout is never re-sent.
- The merge also gets `base`, the last server copy the document adopted or saved (before the first load, the cached copy). `customThemes` is merged by theme id against it (`mergeThemes` in `model.ts`): local adds are appended, local edits replace the server's theme or bring it back, a local delete applies only if the server's copy is still as it was in `base`. So an edit wins over a delete on either device, and a theme added on another device is not lost. Limits: the same id added on two devices at once keeps this device's version, and more than 16 themes after a merge drops the last ones (`parseAccount`).
- Known limit, carried: the keybindings list (`keybindings-store.ts`, field `rules`) is still one field. A conflict keeps this device's whole list when it changed `rules`, so a rule added on another device since the last sync is lost. It needs the same by-id merge, which waits for stable rule ids.
- Boot cache: `apply.ts` writes `pap.appearance.boot`; `boot-script.js` replays it before first paint, accepting only allowlisted attributes and variables with plain values. It is emitted as an external hashed file by `vite/appearance-boot.ts` and linked first in `<head>`, because the CSP forbids inline scripts.
- `parseAccount` reads the stored document field by field: each enum/boolean falls back on its own, `customThemes` keeps valid entries (first duplicate id wins, at most 16 kept, 64 examined), a side whose theme is gone or sits on the wrong base falls back to `night`/`day`. Never reset the whole document for one bad field.
- Mode picks the side (Night / Day / System). Dark side: Night Control, High contrast or a custom night theme. Light side: Day Papier or a custom day theme.
- Token selectors are attribute selectors (`[data-theme="…"]`, `[data-density="…"]`) of equal specificity, so the boot script's attribute always wins over the no-JS fallback. `tokens.css` uses `@theme inline`, not `@theme static` as DESIGN §14 writes: a utility must read `var(--bg)` where it is used, so a `data-theme` on a subtree (gallery frames, the logo's mode) re-themes it. A non-inline theme resolves the variable once on `:root`. Do not "fix" it.
- `deriveTheme` mixes (8, 13, 22, 35, 38, 55, 58 %) are pap's own numbers for DESIGN §13.2. `control-border` and `focus-ring` reach 3:1 on bg and surface; `attn-title` 4.5:1 on the attention tint over the surface (ADR 0012).
- `contrast.ts` and `derive.ts` hold colour math, pinned by tests; the ignore list of `pap/no-raw-colors` in `eslint.config.js` names them with `presets.ts`.

## Commands (`features/commands/`)

- `registry.ts` holds the command specs; `defaults.ts` the default chords (each has `!panelFocus`, Escape also `!overlayOpen`); the user's rules live per account (`keybindings-store.ts`, `pap.keybindings.v1`) and merge over the defaults in `resolve.ts`.
- `when` keys (`CONTEXT_KEYS`): `editableFocus`, `dialogOpen`, `overlayOpen`, `panelFocus` (focus inside `[data-terminal-input]`), `paletteOpen`, `treeOpen`, `sessionFocus`, `mobile`.
- The dispatcher bails out on a composition (IME `keyCode` 229, `isComposing`), on AltGr, on a lone modifier and on a reserved chord (`RESERVED` in `resolve.ts`, per platform). The recorder stores digits and punctuation by physical key (`event.code`), letters by layout key.
- The editor (`editor/`, lazy) shows conflicts and overlapping clauses; a JSON import that would wipe the bindings is refused.

## i18n (`i18n/`)

- `useT()` in components (re-renders on a locale or catalog change); `t()` only outside React, at the moment of use. Both fall back on the key and warn `message_missing`.
- Eager catalog: `en.ts` / `fr.ts`, merged from `catalog/*.ts`. Every key exists in both languages; a French string equal to the English one needs an `IDENTICAL_IN_FR` entry with a reason.
- Lazy catalog pattern: a chunk's strings live in `catalog/<name>.ts` (`settings-screen.ts`, `gallery.ts`) and are added by `registerCatalog({ en, fr })` at the chunk's evaluation. `MessageKey` reaches them through type-only imports. `lazy-catalog.test.tsx` holds the exempt list: the explicit set of Settings chunk files that may name those keys (every listed file must exist); any other file naming one fails the test, so eager code cannot render a raw key.
- The literal gate (`scripts/literal-coverage.ts`, allowlist `scripts/literal-allowlist.json`, every entry with a reason) refuses UI text outside the catalogs. `serverText` maps the daemon's English texts to French by pattern until server codes land (P4).

## Markdown (`packages/ui/src/ai/Markdown.tsx`, `markdown/`)

- react-markdown plus remark-gfm, no raw HTML, safe link protocols only, no images (model text never loads a resource). Code fences use shiki with its JavaScript regex engine (no WebAssembly, CSP unchanged) and the code colours of the tokens.
- The renderer and the highlighter are lazy; a load failure calls `onLoadError`.

## Gates

- Class coverage (`scripts/class-coverage.ts`): every class in `className`, `cn(...)` and constants named `*CLASSES|VARIANTS|SIZES|TONES|STYLE|RING` must compile with the real Tailwind config. Class lists live only there. `features/sessions` is scanned from P7.
- Compiler gate (`compiler-gate.test.ts`, `compiler-pipeline.int.test.ts`): React Compiler runs over `@pap/ui` and the app.
- `pap/no-native-title`: icon buttons use a labelled tooltip, never `title`. Touch targets: the gallery probe checks classes for 44 px under `pointer: coarse`; it does not measure.
- `build-output.int.test.ts`: no inline script, boot script first, fonts as files, no WebAssembly, no gallery in any prod asset, and lazy-only markers (Settings, palette `cmdk-input`, the overlays `data-pap-modal` and the shortcuts help `data-command`, primitives, shortcuts editor, theme editor, markdown), and the zod chunk loading without an eval attempt absent from every initial file; the initial size is held to `budgets.json`.

## Bundle

- `@pap/ui` declares `"sideEffects": ["*.css"]` and `@pap/contracts` `"sideEffects": false`. Without it, barrel re-exports pin every re-exported module (and its dependencies) into the initial graph even when unused. Import lazy-only features from their own file, not from a feature `index.ts`.
- Measured on the M3 build: initial 192.1 KB gzip (JS and CSS, 15 files; 192.4 before `sideEffects: false` on contracts). `budgets.json` is 200: 192.1 x 1.10 rounds up to 212, capped at the owner ceiling of 200. About 8 KB of headroom.
- Largest lazy chunks (gzip): shiki core `highlight` 47.3 KB, markdown `render` 46.3 KB, Settings 34.7 KB, `javascript`/`jsx`/`tsx`/`typescript` grammars about 15.5 KB each, `overlays` 14.4 KB, palette 5.9 KB, theme editor 3.7 KB. `pnpm budgets` prints all of them.
- Biggest initial item: `runtime-*` (zod, about 29 KB gzip). Not reduced (`zod/mini` and a lazy `MobileShell` were left out of M3).

## Deferred (not done, not checked)

- Browser e2e in Chromium and WebKit, runtime CSP violation checks, measured 44 x 44 px targets, gallery screenshots, PNG icons, the R118 Safari 16.4 WebSocket check. M3 verifies in happy-dom, Tailwind compiles and Vite builds only.

## Traps

- Safari 16.4 floor: no native CSS nesting in shipped CSS, no `light-dark()`, no RegExp `v` flag; `:has()` is allowed.
- IME `keyCode` 229 and AltGr produce false chords: see the dispatcher bail-outs above.
- No native `title` attribute. Colours reach components through token utilities only; no raw colours, no `[…]` arbitrary values.
- A lazy-only component imported through a barrel lands in the initial bundle; `build-output.int.test.ts` catches it.
