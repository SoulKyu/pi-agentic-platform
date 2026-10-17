/**
 * The markers each lazy chunk keeps out of the initial assets (M10 agreement 23, M11R110): `build-output.int.test.ts`
 * builds the app once and checks every row against it. A row names a marker of a lazy component (an attribute it
 * renders, a string of its catalog); the test fails when no chunk holds it, or when an initial file does.
 * Add the markers of a new lazy screen here, in one row.
 */
export interface LazyMarkers {
  readonly title: string;
  readonly markers: readonly RegExp[];
}

export const LAZY_MARKERS: readonly LazyMarkers[] = [
  {
    title: "keeps the Settings screen out of the initial assets",
    markers: [/data-settings-screen/],
  },
  {
    title: "keeps the lane tab and its strings out of the initial assets (M9R62)",
    markers: [/data-lane-notice/, /Files differ from this point/, /Les fichiers diffèrent de ce point/],
  },
  {
    title: "keeps the new lane dialog and its strings out of the initial assets (M9R95)",
    markers: [/data-slot":\W*new-lane/, /Fetch issue/, /Récupérer l'issue/],
  },
  {
    title: "keeps the Add project dialog and its strings out of the initial assets (decision 85)",
    markers: [/data-add-project/, /Project folder: /, /Dossier du projet : /],
  },
  {
    title:
      "keeps the home's launch, project facts and picker, and their strings, out of the initial assets (the 226 KB limit)",
    markers: [
      /pap could not open the New lane dialog/,
      /Lane and Fan-out: not a git repository/,
      /Lane et Fan-out : pas un dépôt git/,
      /Launch in which project/,
    ],
  },
  {
    title: "keeps the home's body, its picker and their strings out of the initial assets (decision 85)",
    markers: [/data-home-body/, /data-project-picker/, /Recent work/, /Travail récent/],
  },
  {
    title: "keeps the compare tab and its strings out of the initial assets (M9R96)",
    markers: [/data-winner/, /Close losers/, /Fermer les perdantes/],
  },
  {
    title:
      "keeps the lane review pane, its diff view and its strings out of the initial assets (M9R87, M9R88)",
    markers: [
      /data-review-pane/,
      /cm-review-comment/,
      /Too large to show here/,
      /Trop volumineux pour être affiché ici/,
    ],
  },
  {
    title: "keeps Settings › Automation and its strings out of the initial assets (M10R121)",
    markers: [/data-automation-section/, /Counts triggers and automatic resumes/, /Compte les déclencheurs/],
  },
  {
    title: "keeps the Approvals strings out of the initial assets",
    markers: [/What the agent may do without asking you/],
  },
  {
    title: "keeps lazy-only primitives out of the initial assets",
    markers: [
      /data-radix-select-viewport/,
      /"data-slot":\W*segmented/,
      /"data-slot":\W*slider/,
      /role:\W*slider/,
    ],
  },
  {
    title:
      "keeps the appearance panel out of the initial assets (import it from its file, not from the feature index)",
    markers: [/data-slot":\W*appearance-status/],
  },
  {
    title:
      "keeps the shortcuts editor out of the initial assets (import it from its file, not from the feature index)",
    markers: [/data-slot":\W*shortcuts-status/],
  },
  {
    title: "keeps the theme editor out of the initial assets, in a chunk of its own (M3R117)",
    markers: [/data-slot":\W*theme-preview/],
  },
  {
    title: "loads the Settings strings with the Settings chunk, not with the initial catalog",
    markers: [/Saved to your account/, /Enregistré dans votre compte/],
  },
  {
    title: "loads M2's session strings with the session chunk, not with the initial catalog",
    markers: [/Load older messages/, /Charger les messages plus anciens/],
  },
  {
    title: "keeps the Tasks and Trigger panes out of the initial assets (M10R112)",
    markers: [/data-tasks-pane/, /data-trigger-pane/, /data-trigger-editor/],
  },
  {
    title: "keeps the Tasks board and its strings out of the initial assets (M10R113)",
    markers: [/data-tasks-board/, /Triggers run tasks for you on a schedule/],
  },
  {
    title: "loads the pane strings with their chunks, not with the initial catalog (M8R71)",
    markers: [
      /Eight files are open and all have unsaved changes/,
      /Showing the first 2 000 changes/,
      /Affichage des 2 000 premières modifications/,
    ],
  },
  // The app imports CodeEditor (the files viewer) and DiffView (the changes pane) from `@pap/ui/code`, so its build has
  // the editor chunk and the merge view chunk; neither is in an initial file.
  {
    title: "keeps CodeMirror and the merge view out of the initial assets (the app imports @pap/ui/code)",
    markers: [/cm-editor/, /cm-mergeView/],
  },
  // The app imports TerminalSurface from `@pap/ui/terminal`; xterm, its addons and its stylesheet load with the pane.
  {
    title: "keeps xterm and the terminal strings out of the initial assets (M8R80)",
    markers: [
      /xterm-helper-textarea/,
      /xterm-screen/,
      /Reconnecting… input paused/,
      /Reconnexion… saisie en pause/,
    ],
  },
  {
    title: "keeps the project tree and its strings out of the initial assets",
    markers: [/data-project-tree/, /Show 20 more/],
  },
  {
    title: "keeps the overlays (dialog, menu) and the shortcuts help out of the initial assets",
    markers: [/"data-pap-modal":/, /"data-command":/],
  },
  {
    title:
      "keeps the session screen out of the initial assets, so the session UI of later milestones lands in its chunk",
    markers: [/"data-failure"/],
  },
  {
    title:
      "keeps the extension surfaces (@pap/ui/extensions: questions, status bar, widgets, custom panel) out of the initial assets",
    markers: [
      /"data-extension-label"/,
      /"data-terminal-input"/,
      /"data-widget-line"/,
      /data-slot":\W*status-bar/,
      /data-slot":\W*ansi-text/,
    ],
  },
  {
    title: "keeps the palette (cmdk) out of the initial assets",
    markers: [/cmdk-input/],
  },
  {
    title: "keeps the Inbox panel out of the initial assets",
    markers: [/data-inbox-panel/],
  },
  // M11.
  {
    title:
      "keeps the Inbox agent rows, the secret dialog and their strings out of the initial assets (M11R129, M11R130)",
    markers: [/data-row-detail/, /Secret requested: /, /Secret demandé : /],
  },
  {
    title:
      "keeps the agent tab, its event cards and its strings out of the initial assets (M11R109, M11R118)",
    markers: [
      /data-agent-pane/,
      /data-event-card/,
      /Result handed over by/,
      /Résultat remis par/,
      /asks before it acts/,
      /demande avant d'agir/,
    ],
  },
  {
    title: "keeps the agent status panel and its strings out of the initial assets (M11R125)",
    markers: [/data-status-panel/, /Budget today/, /Budget du jour/],
  },
  {
    title:
      "keeps the agent's Settings tab (permissions sheet, secrets list, quarantine, delete) and its strings out of the initial assets (M11R126)",
    markers: [
      /data-agent-settings/,
      /data-agent-permissions/,
      /data-agent-secrets/,
      /Lethal trifecta/,
      /Triade létale/,
      /This is the incident button/,
      /Resume from quarantine/,
    ],
  },
  {
    title: "keeps the phone Agents list and its empty-state strings out of the initial assets (M11R109)",
    markers: [/Create your first agent/, /Créez votre premier agent/],
  },
  {
    title:
      "keeps Settings › Agents, the agent form and the sandbox status out of the initial assets (M11R97)",
    markers: [
      /A named assistant with its own home, memory and limits\./,
      /data-slot":\W*agents-sandbox/,
      /Named assistants with their own home, memory and limits\./,
      /Des assistants nommés, avec leur propre dossier personnel/,
    ],
  },
  {
    title:
      "keeps the method catalogue's schemas out of the initial assets: rpc.ts reads METHOD_IDEMPOTENT (about 6 KB gzip)",
    markers: [/name:\W*policy\.revokeRule\W*,\s*permission/],
  },
];

/**
 * Components no eager file may carry (`build-output.agents.int.test.ts`, M11R110): the first paint holds the rail and
 * nothing behind it.
 */
export const EAGER_FORBIDDEN: ReadonlyArray<{ readonly component: string; readonly marker: RegExp }> = [
  { component: "AgentForm", marker: /data-agent-form/ },
  { component: "SandboxStatus", marker: /data-slot":\W*agents-sandbox/ },
  { component: "AgentScreen", marker: /data-agent-pane/ },
  { component: "EventCard", marker: /Result handed over by/ },
  { component: "RequestCards", marker: /asks before it acts/ },
  { component: "StatusPanel", marker: /data-status-panel/ },
  { component: "SecretDialog", marker: /Secret requested: / },
  { component: "AgentInboxRow", marker: /data-row-detail/ },
  { component: "AgentSettingsTab", marker: /data-agent-settings/ },
  { component: "PermissionsSheet", marker: /data-agent-permissions/ },
  { component: "SecretsList", marker: /data-agent-secrets/ },
  { component: "QuarantineDialog", marker: /This is the incident button/ },
];
