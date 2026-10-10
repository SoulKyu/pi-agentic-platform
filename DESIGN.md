# DESIGN.md: pap design system ("Night Control")

Status: v1, **validated by the product owner on 2026-10-10** · Spec B of pi-agentic-platform.

This document is the source of truth for anything visual. It was built with the product owner over ten visual rounds; the illustrated history is in [docs/design/explorations/](docs/design/explorations/) (pages 01–12) and the numbered decisions are in [docs/research/decisions-log.md](docs/research/decisions-log.md) (11, 25–32). Implementation lives in `packages/ui` (spec C §7).

## 1. Identity

**Night Control.** It takes the grammar of a mission-control room and dresses it in calm, flat colour:

- colour means role;
- structure labels are monospaced capitals;
- corners are sharp;
- a faint grid runs behind everything.

**No gradients and no glow, ever.** The interface stays quiet so that the agents' work is the loudest thing on screen.

The design is a cross between two explored directions: Mission Control (grammar) and Aurora (palette and type) (decision 11).

## 2. Colour = role

The one rule everyone must know. Hues are never decorative.

| Role | Meaning | Where it appears |
|---|---|---|
| **Agent** (violet) | what an agent does or says | 2 px rule left of agent messages, agent names, tool labels, running state, selected item rule, agent avatars |
| **You** (orange) | the human and the primary action | your messages, primary buttons, composer focus, keyboard focus ring |
| **Attention** (pink) | something waits for you | approvals, input requests, unread badges, Inbox items to handle, failures to act on |
| **OK** (green) | success | passed checks, done tasks, added diff lines |
| **Error** (red) | something broke | crash banners, failed runs, removed diff lines |
| Neutrals | structure | backgrounds, surfaces, borders, muted text |

### Visual code for trust (decision 29)

| Pattern | Meaning |
|---|---|
| Solid 1 px frame | comes from the platform (task, schedule, notification) |
| **Dashed attention frame + `UNTRUSTED · <source>` label** | external content, fenced (webhook, feed, web, third-party MCP) |
| Dashed attention chip "external content" | the run is tainted: exfiltration-capable actions will ask again (spec C §5) |
| Solid attention fill / tint | waiting for your answer |

Colour is never the only carrier. Every status chip carries a word, and dashed versus solid adds a cue that does not depend on colour.

## 3. Tokens

All values are CSS custom properties defined in `packages/ui/src/tokens.css`, scoped by `[data-theme]` and `[data-density]` on `<html>`.

### 3.1 Night (default dark)

| Token | Value | Use |
|---|---|---|
| `--bg` | `#110F18` | app background |
| `--bg-side` | `#14111D` | rail, top bar, drawers, side panels |
| `--surface` | `#1A1724` | cards, composer, tool cards |
| `--surface-2` | `#241F33` | selected rows, active tabs, inline code |
| `--border` | `#2D2840` | hairlines |
| `--border-strong` | `#3D3657` | card and control borders |
| `--text` | `#F2EFFA` | primary text |
| `--text-muted` | `#9C95B5` | secondary text, meta |
| `--text-dim` | `#6B6485` | idle avatars, disabled |
| `--grid` | `#FFFFFF06` | background grid lines |
| `--agent` / `--agent-fill` / `--agent-ink` | `#A78BFA` / `#A78BFA` / `#110F18` | agent role |
| `--you` / `--you-fill` / `--you-ink` | `#FB923C` / `#FB923C` / `#1B0D00` | you role |
| `--you-tint` / `--you-line` / `--you-text` | `#FB923C1A` / `#FB923C66` / `#FED7AA` | your message box |
| `--attn` / `--attn-fill` / `--attn-ink` | `#EC4899` / `#EC4899` / `#FFFFFF` | attention role |
| `--attn-tint` / `--attn-line` | `#EC48991A` / `#EC48998C` | approval cards, Inbox highlight |
| `--ok` | `#34D399` | success |
| `--err` | `#F87171` | error |
| `--diff-add` / `--diff-del` | `#34D39914` / `#F8717114` | diff line backgrounds |

### 3.2 Day · Papier (default light)

**Fills keep the night hue.** The primary button stays the same orange in both modes. Text and line tones are darkened to reach AA.

| Token | Value |
|---|---|
| `--bg` / `--bg-side` / `--surface` / `--surface-2` | `#FAF9F6` / `#F3F1EC` / `#FFFFFF` / `#EEEBE4` |
| `--border` / `--border-strong` | `#E2DED5` / `#CFC9BC` |
| `--text` / `--text-muted` / `--text-dim` | `#1C1917` / `#6B645A` / `#A8A196` |
| `--grid` | `#1C19170A` |
| `--agent` / `--agent-fill` / `--agent-ink` | `#6D28D9` / `#7C3AED` / `#FFFFFF` |
| `--you` / `--you-fill` / `--you-ink` | `#C2410C` / `#FB923C` / `#1B0D00` |
| `--you-tint` / `--you-line` / `--you-text` | `#FFF4EA` / `#FDBA74` / `#431407` |
| `--attn` / `--attn-fill` / `--attn-ink` | `#BE185D` / `#DB2777` / `#FFFFFF` |
| `--attn-tint` / `--attn-line` | `#FDF1F6` / `#F9A8D4` |
| `--ok` / `--err` | `#047857` / `#DC2626` |
| `--diff-add` / `--diff-del` | `#04785714` / `#DC262614` |

### 3.3 High contrast (accessibility preset)

| Token | Value |
|---|---|
| `--bg` / `--bg-side` / `--surface` / `--surface-2` | `#000000` / `#0A0A0A` / `#111111` / `#1F1F1F` |
| `--border` / `--border-strong` | `#5A5A5A` / `#8A8A8A` |
| `--text` / `--text-muted` / `--text-dim` | `#FFFFFF` / `#D0D0D0` / `#A0A0A0` |
| `--agent` / `--you` / `--attn` / `--ok` / `--err` | `#C4B5FD` / `#FDBA74` / `#F9A8D4` / `#6EE7B7` / `#FCA5A5` |
| fills | same as night (`#A78BFA`, `#FB923C`, `#EC4899`) |
| `--grid` | `transparent` |

### 3.4 Geometry and depth

| Token | Value | Rule |
|---|---|---|
| `--radius-sm` | 2 px | buttons, inputs, chips, tabs, kbd |
| `--radius-md` | 3 px | cards, panels, avatars, dialogs |
| round | 50 % | status dots and count badges only |
| `--grid-size` | 24 px (16 px on mobile) | background grid; can be turned off |
| `--shadow-overlay` | night `0 20px 60px rgba(0,0,0,.6)` · day `0 12px 40px rgba(28,25,23,.18)` | **only** drawers, palette, dialogs, toasts |

Surfaces never cast shadows. Separation comes from surface steps and 1 px borders.

## 4. Typography

Two families, **self-hosted as woff2 in `packages/ui`**. No font CDN at runtime: zero telemetry, offline-safe.

- **Manrope** (400, 500, 600, 700, 800) for UI, prose and headings.
- **JetBrains Mono** (400, 500, 600) for structure labels, code, tool output and numbers.

| Style | Spec |
|---|---|
| display | Manrope 28 / 800 / −0.02em |
| h1 | Manrope 20 / 800 |
| h2 | Manrope 16 / 700 |
| label (HUD) | JetBrains Mono 10–10.5 / 600 / uppercase / 0.1–0.12em, muted or role colour |
| numbers | JetBrains Mono with `font-variant-numeric: tabular-nums` (costs, durations, diff counts) |
| body, prose, code | per density (§5) |

Uppercase HUD labels can be switched off in Settings; they then render in sentence case at the same size.

## 5. Density (decision 27)

| Token | Compact (default) | Comfortable | Mixed |
|---|---|---|---|
| UI text | 13 px | 14 px | 13 px |
| chat prose / line-height | 14 px / 1.55 | 15 px / 1.65 | 15 px / 1.65 |
| code | 12 px | 12.5 px | 12 px |
| spacing steps | 4 · 8 · 12 · 16 · 24 · 32 | 6 · 10 · 16 · 24 · 32 | as Compact |
| control height | 26 px | 32 px | 26 px |
| rail / top bar / tab bar | 48 / 34 / 34 px | 56 / 40 / 40 px | 48 / 34 / 34 px |
| agent avatar | 28 px | 32 px | 28 px |

Under `pointer: coarse`, every interactive target is at least **44 × 44 px**, whatever the density.

## 6. Logo and name (decision 26)

### 6.1 Mark: the "two legs" π

The mark sits on a 32-unit grid:

- top bar `rect(6, 9, 20, 3.2)` in text colour;
- left leg `rect(10.4, 12, 3.2, 13)` in **agent** colour;
- right leg (curved foot) `path M18.6 12h3.2v9.4c0 1.4.5 2 1.6 2h.9V26h-1.6c-2.8 0-4.1-1.4-4.1-4.4z` in **you** colour.

It reads as an agent and a human under one roof.

### 6.2 Name and wordmark

- The displayed name is **`pap`**, set in Manrope 800, −0.02em, lowercase.
- The optional tagline "pi agentic platform" is set in mono uppercase, 0.12em, muted.
- The repository and npm package keep the name `pi-agentic-platform`.

### 6.3 Sizes and assets

- Minimum size 16 px.
- Clear space is ¼ of the mark's width.
- Favicons (16 and 32) sit on a `--surface` tile.
- PWA icons are 192 and 512 px, maskable, on the night background. The day variant uses the darkened leg tones.

### 6.4 Don'ts

Never use gradients, glow, outlines around the legs, rotation, or swapped leg colours. Agent is always left and violet; you are always right and orange.

## 7. Iconography and motion

### 7.1 Icons

- lucide, with a 1.5 px stroke, in `currentColor`.
- 16 px by default, 14 px in compact rows.
- Every icon-only button has an accessible label and a tooltip; the native `title` attribute is not used.

### 7.2 Motion

- Durations: 0 ms (state swaps), 120 ms (hover, press), 200 ms (drawers, dialogs). Standard ease-out.
- **Nothing repaints continuously.** The one exception is the thin indeterminate bar on a running tool card, which becomes static under reduced motion.
- Motion follows the system setting by default, with a "reduced" or "none" override per device.

### 7.3 Feedback timing (Orca rule)

| Delay | Feedback |
|---|---|
| under 100 ms | nothing |
| 100 ms to 1 s | control disabled |
| 1 s to 3 s | spinner |
| over 3 s | a stage label ("Preparing worktree…") |

Remote spinners are deferred by about 200 ms, but the control is disabled immediately.

### 7.4 Focus

A 2 px solid `--you-fill` outline with a 2 px offset on `:focus-visible`. It is never removed.

## 8. Layout (decision 25)

```
┌──┬──────────────────────────────────────────────────────────┐
│π │ project ▾   ⌘B (tree drawer)            Inbox n    ⌘K    │  top bar
│AT├──────────────────────────────────────────────────────────┤
│SC│ [Atlas] [feat/checkpoints ●] [fix/webhook] [+]   ⊞ split  │  open items = tabs
│LG├────────────────────────────┬─────────────────────────────┤
│  │ pane: chat                 │ pane: review / terminal /   │  splittable panes,
│  │                            │ diff / files / status       │  layout saved per lane
└──┴────────────────────────────┴─────────────────────────────┘
 rail: agents (always visible)
```

- **Rail**: logo plus agent avatars, with unread badges and presence dots. It is always visible and can be placed left or right (Settings).
- **Top bar**: project switcher, ⌘B drawer, Inbox, ⌘K.
- **Tabs bar**: what is open (lanes, sessions, agent threads, settings, tasks). Closing a tab deletes nothing.
- **Panes**: splittable. Minimum width 320 px. The layout is remembered per lane.
- **Drawers**:
  - left: the ⌘B tree (project → lane → session), 300 px;
  - right: the Inbox, 360 px.
- **Agent tab**: thread plus the status panel (330 px, always visible on desktop).

| Breakpoint | Layout |
|---|---|
| ≥ 1280 px | full cockpit |
| 768–1279 px | rail + panes; the agent status panel becomes a pane |
| < 768 px (phone) | bottom nav **Agents / Work / Lists / Inbox**, one pane at a time with a Chat / Review / Term segmented switch, bottom sheets for menus |

## 9. Components

### 9.1 Primitives

Built on Radix and owned in shadcn style. Each primitive owns its look: callers pick a `variant` and a `size`, never a `className` restyle.

| Component | Variants and rules |
|---|---|
| Button | `primary` (you fill), `secondary` (outline), `ghost`, `danger` (error, outline, used only for irreversible actions). Labels in mono uppercase. **Cancel is never `danger`.** |
| IconButton | square, label and tooltip mandatory |
| Input, Textarea, Select | 1 px `--border-strong`, `--bg` fill, focus ring |
| Segmented | mono uppercase items; the active item gets an agent underline |
| Switch, Checkbox | square, no pill shapes |
| Slider | 2 px track, square thumb |
| Chip (status) | mono uppercase word + optional dot; tone = role (`run`, `ok`, `att`, `err`, `mut`, `ext` dashed) |
| Badge (count) | round, attention fill |
| Kbd | mono, bordered |
| Tabs (open items) | mono uppercase; active tab gets an agent border and the `--surface-2` fill |
| Tooltip, Menu, Dialog, Drawer, Sheet | overlays carry `--shadow-overlay`; Escape and focus trapping (pi-web `stacked-dialog` rules) |
| Toast | bottom right (bottom on phones), with **Undo** for reversible actions, 5 s |
| Banner | crash (error), capacity (neutral), offline (dashed), checkpoint (you tint) |
| Avatar (agent) | outlined initials by default; outlined / tinted / glyph styles selectable; presence dot; count badge |
| Meter | budget bars: tokens in agent colour, cost in you colour |
| ProgressBar | determinate, or thin indeterminate (running tool) |
| EmptyState | dashed frame, one sentence of purpose, one primary action |

### 9.2 AI components

All live in `packages/ui/src/ai`.

| Component | Spec |
|---|---|
| Message · you | right-aligned box with `--you-tint`, a `--you-line` border and `--you-text`; label `YOU` |
| Message · agent | 2 px agent rule on the left, mono uppercase name and meta (time, "thought Ns") |
| AuthorGroup | consecutive messages share one avatar and header (pi-web conversation view) |
| Reasoning | collapsed "▸ thought for 14s", expandable |
| ToolCard | header with tool name (mono uppercase, agent colour), argument summary and duration; output body; indeterminate bar while running. Detail level compact (one line) / expanded / full is selectable in Settings. Renderers for bash, edit (diff), read, MCP (server/tool from result details), codemode (nested calls) |
| ApprovalCard | attention tint and line; header `Approval · <category>` (+ `· external content` when tainted); the question; context (diff stats, trigger, tests); answers **Deny / Session / Always / Allow once** |
| InputRequestCard | Pi `select` / `input` / `editor` dialogs rendered in the stream; unknown methods are cancelled |
| CustomPanel | `ctx.ui.custom()` lines in mono; takes keyboard focus; re-rendered whole on each update |
| StatusBar, Widgets | extension `setStatus` / `setWidget` / `setTitle`, with `command:` buttons |
| EventCard | solid frame = platform event; dashed attention frame + Fence = external event |
| Fence | `UNTRUSTED · <source>` label, mono, dashed border, dimmed text |
| CheckpointBanner | "Files differ from this point" → Restore files / Undo |
| PendingRequestsStrip | outgoing requests still queued or running, with Cancel |
| PromptChips | `/name` chips from the agent's `prompts/`, at most 12 |
| Composer | tiptap; chips `@file`, `$skill`, `/command`, `@Agent`; model and reasoning pill; send button in you fill; orange focus border; steer / follow-up queue displayed above |
| DaySeparator | inline line with a mono label, not sticky |
| RunStatusChip | working · settled · interrupted · limited · needs input |
| DiffView | unified; line numbers; line comments in you colour; file checklist with Seen state |
| CompareColumn | fan-out result: tests, diff, files, duration, cost, summary, "pick winner" |
| TriggerVerdict | dry-run outcome (would fire / would skip + reason), the fenced prompt preview |

Every component is shown in **/dev/ui** in all three themes and three densities. The page returns 404 in production and sits behind auth.

## 10. Screens

Each screen was validated in a visual round; the HTML page next to it is the reference.

| Screen | Reference | Key points |
|---|---|---|
| Shell | [05-shell-mix-ac](docs/design/explorations/05-shell-mix-ac.html) | rail + cockpit, tree drawer, tabs, panes |
| Agent space + Inbox | [09-agent-space-inbox](docs/design/explorations/09-agent-space-inbox.html) | thread, event cards, fence, status panel, Inbox drawer |
| Lanes | [10-lanes](docs/design/explorations/10-lanes.html) | lane header, checkpoint banner, review with Seen and comments, commit bar, fan-out compare, new lane from issue |
| Automation | [11-automation](docs/design/explorations/11-automation.html) | trigger editor + dry-run, fire journal, tasks board per agent |
| Settings › Appearance | [08-settings-appearance](docs/design/explorations/08-settings-appearance.html) | per account vs per device, role-token theme editor |
| Mobile + system | [12-mobile-system](docs/design/explorations/12-mobile-system.html) | push approval, thread, review, Inbox; setup, login, ⌘K, states |

Screens not drawn in a round follow the same components and patterns: MCP, models, skills, memory, security, health, files, terminal. The pi-web settings panels are the functional reference; they are restyled, not redesigned.

## 11. Content and voice

- **Languages**: English and French. Every string goes through the internal i18n layer; no string is concatenated around variables.
- **Case**: sentence case for text. HUD labels are short mono capitals ("APPROVAL NEEDED", "WORKING").
- **Never overclaim**: "Allow once", not "Safely allow". "Archived", not "Done!". No exclamation marks in system copy.
- **Errors** say three things: what happened, what is intact, and what you can do. Example: "Agent process killed: out of memory (MemoryMax 2 GB). The transcript is intact. Retry."
- **Refusals** are explicit, never silent. Example: "Capacity reached · 6 / 6 workers…".
- **Numbers**:
  - costs in `$0.00` (provider cost or API-equivalent, labelled);
  - durations as `3m40` or `00:07`;
  - diff counts as `+214 −38`;
  - all in tabular figures.
- **Secrets** are never displayed. They appear as names or `[SECRET:NAME]`.
- **External content** is always fenced and labelled with its source.

## 12. Accessibility

- Text meets WCAG AA (4.5:1, 3:1 for large text) in all three themes. The theme editor shows the ratio per role and asks for confirmation below AA.
- 44 px touch targets; full keyboard reachability; ⌘K for every navigation; a visible focus ring.
- Reduced motion honoured. Colour is never the only signal (§2).
- Status chips and badges expose their text to screen readers. Live regions announce run end, approvals and errors politely.

## 13. Customization (decisions 27–28)

Everything visual can be changed in **Settings › Appearance**, with a live preview and a reset to defaults.

| Scope | Settings |
|---|---|
| Per account (server) | mode Night / Day / System (default System); theme preset (Night Control, Day · Papier, High contrast) or custom theme; UI and mono fonts; uppercase labels on/off; grid on/off; rail position left/right; avatar style; tool card detail level |
| Per device (local) | density; UI, chat and code sizes; motion; chat max width (default full width) |

### 13.1 Custom themes

A custom theme edits **roles**, not individual variables. Its JSON can be imported and exported:

```json
{
  "name": "My theme",
  "base": "night",
  "roles": { "bg": "#0E1626", "surface": "#132033", "agent": "#38BDF8", "you": "#FB923C",
             "attn": "#EC4899", "ok": "#34D399", "err": "#F87171", "text": "#E6EDF7" }
}
```

### 13.2 Derived tokens

| Derived token | Rule |
|---|---|
| `*-tint` | role at 10 % alpha |
| `*-line` | role at 40–55 % alpha |
| `--surface-2` / `--border*` | stepped from `bg` and `surface` |
| day text tones | darkened until they reach 4.5:1 on `bg` |

Custom CSS and full cross-device sync are out of scope.

## 14. Implementation map

| Concern | Where |
|---|---|
| tokens per theme and density | `packages/ui/src/tokens.css` (`[data-theme="night\|day\|hc"]`, `[data-density="compact\|comfortable\|mixed"]`) |
| Tailwind 4 | `@theme static` maps tokens to utilities; no raw colours or arbitrary values (lint) |
| fonts | `packages/ui/fonts/*.woff2`, `font-display: swap` |
| primitives / AI components | `packages/ui/src/primitives`, `packages/ui/src/ai` |
| icons | `lucide-react`, wrapped by `Icon` (size and stroke defaults) |
| logo | `packages/ui/src/brand/Mark.tsx` (inline SVG, props `mode`, `size`) + generated favicons and PWA icons |
| gallery | `/dev/ui` |
| visual regression | Playwright screenshots of `/dev/ui` in 3 themes × 2 densities (spec C §8) |
| appearance settings | the `settings` module (account scope) + `localStorage` (device scope), applied as `data-*` attributes before first paint to avoid a flash |
