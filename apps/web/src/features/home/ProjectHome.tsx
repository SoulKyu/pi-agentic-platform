import type { HomeLayout, ToolPreset } from "@pap/contracts";
import { Button, TextField, useIsPhone, InlineError } from "@pap/ui";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useLazyFailureText, useT } from "../../i18n/index.ts";
import { LazyBoundary, notifyLazyFailure, useRetryableLazy } from "../../lib/lazy.tsx";
import { LazyPanel } from "../../lib/LazyPanel.tsx";
import { getRuntime, useConnectionState } from "../../runtime/index.ts";
import { listedProjects, useCurrentProject, useEffectiveProject } from "../../stores/current-project.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import type { HomeActions, HomeShortcuts } from "./home-actions.ts";
import { type HomeMode, isLaunchKey, readMode, rememberMode } from "./home-mode.ts";
import { ModeChips } from "./ModeChips.tsx";
import type { ModeFacts } from "./ProjectFacts.tsx";
import { useLaunch } from "./use-launch.ts";

// The "All projects" picker is a chunk of its own, with the home's lazy catalog: fetched on the first Launch there.
const loadPicker = () => import("./ProjectPicker.tsx");
// What the project allows (a git repository, automation running) arrives with its own chunk and words after the first paint.
const loadFacts = () => import("./ProjectFacts.tsx");

// Under the composer: the action row, the status line and Recent work, one chunk with the home's catalog (§8).
const loadBody = () => import("./HomeBody.tsx");

const NO_REASONS: ModeFacts["reasons"] = {};

export interface ProjectHomeProps {
  readonly actions: HomeActions;
  readonly shortcuts: HomeShortcuts;
  readonly preset: ToolPreset;
  /** Settings › Appearance › Home (§6): which parts of the body show. */
  readonly layout: HomeLayout;
  /** The tool preset field (Session options): another feature's, so the shell renders it. */
  presetField(disabled: boolean): ReactNode;
}

/**
 * The project home (decision 85, §3): the composer first, focused — a mode, one field, Launch. Eager, so the first
 * paint at "/" waits for no chunk. Everything it opens goes through `actions`, which the shell builds.
 */
export function ProjectHome({ actions, shortcuts, preset, layout, presetField }: ProjectHomeProps) {
  "use no memo"; // first-paint component: the compiler's cache slots would cost bundle (the initialBundleGzipKb ceiling in budgets.json)
  const t = useT();
  const lazyText = useLazyFailureText();
  const { Lazy: Body, attempt, retry } = useRetryableLazy(loadBody);
  const phone = useIsPhone();
  const connection = useConnectionState(getRuntime().connection);
  const project = useEffectiveProject();
  const projects = useShellStore((state) => state.view.projects);
  const [facts, setFacts] = useState<ModeFacts | null>(null);
  const reasons = project !== null && facts?.root === project.root ? facts.reasons : NO_REASONS;
  const field = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();
  const optionsId = useId();
  const [text, setText] = useState("");
  const [chosen, setChosen] = useState<HomeMode>(readMode);
  const [options, setOptions] = useState(false);
  const [picking, setPicking] = useState(false);
  const { launch, busy, error } = useLaunch(actions, preset, project?.id ?? null);
  // "New session here" (a project's menu) asks for a session there: Session mode, and the composer takes the focus.
  const startedHere = useCurrentProject((state) => state.startedHere);
  const [seenStart, setSeenStart] = useState(startedHere);
  if (seenStart !== startedHere) {
    setSeenStart(startedHere);
    setChosen("session");
  }
  // On mount the composer takes the focus except under a coarse pointer: a phone's keyboard would cover the page.
  const mountedAt = useRef(startedHere);
  useEffect(() => {
    if (startedHere === mountedAt.current && window.matchMedia?.("(pointer: coarse)").matches) return;
    field.current?.focus();
  }, [startedHere]);
  // A mode this project refuses shows Session here; the device keeps the choice for the others (PH14).
  const mode: HomeMode = reasons[chosen] === undefined ? chosen : "session";
  const offline = connection !== "open";

  const go = () => {
    if (busy || offline) return;
    // The focus sits in the composer when a dialog opens, so one that closes without launching gives it back (§7).
    field.current?.focus();
    if (project === null) {
      setPicking(true);
      return;
    }
    launch(mode, project, text);
  };
  const continueIn = (projectId: string) => {
    setPicking(false);
    field.current?.focus();
    const target = useShellStore.getState().view.projects.get(projectId);
    if (target !== undefined) launch(chosen, target, text);
  };

  return (
    <section
      data-home=""
      aria-labelledby={titleId}
      className="mx-auto flex w-full max-w-3xl flex-col gap-s4 overflow-y-auto p-s4"
    >
      <h1 id={titleId} className="text-h1 text-fg">
        {project?.name ?? t("shell.project.all")}
      </h1>
      <form
        className="flex flex-col gap-s2"
        onSubmit={(event) => {
          event.preventDefault();
          go();
        }}
      >
        <ModeChips
          mode={mode}
          reasons={reasons}
          laneChord={shortcuts.lane}
          onMode={(next) => {
            setChosen(next);
            rememberMode(next);
          }}
        />
        <TextField
          label={t("launch.field")}
          value={text}
          onChange={setText}
          multiline
          rows={3}
          name="launch"
          inputRef={field}
          placeholder={project === null ? t("launch.placeholderAll") : t("launch.placeholder")}
          onKeyDown={(event) => {
            if (!isLaunchKey(event, phone)) return;
            event.preventDefault();
            go();
          }}
          onSubmitShortcut={go}
        />
        <div className="flex flex-wrap items-center gap-s2">
          <Button
            type="submit"
            variant="primary"
            disabled={busy || offline}
            aria-label={t(`launch.go.${mode}`)}
          >
            {t("launch.go")}
          </Button>
          {mode === "session" ? (
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={options}
              aria-controls={optionsId}
              onClick={() => setOptions((open) => !open)}
            >
              {t("launch.options")}
            </Button>
          ) : null}
        </div>
        {mode === "session" && options ? (
          <div id={optionsId} className="max-w-64">
            {presetField(busy)}
          </div>
        ) : null}
        {error === null ? null : <InlineError announce="action">{error}</InlineError>}
      </form>
      <LazyPanel
        text={lazyText}
        load={loadFacts}
        open={project !== null}
        props={{ root: project?.root ?? "", box: project?.kind === "box", onFacts: setFacts }}
        // LazyPanel already notifies the failure; the facts are optional.
        onFailed={() => undefined}
      />
      <LazyPanel
        text={lazyText}
        load={loadPicker}
        open={picking}
        props={{
          projects: listedProjects(projects),
          onPick: continueIn,
          onAdd: () => {
            setPicking(false);
            // The picker's button held the focus and is gone: the dialog gives the focus back to the composer.
            field.current?.focus();
            actions.addProject(continueIn);
          },
          onClose: () => {
            setPicking(false);
            field.current?.focus();
          },
        }}
        onFailed={() => setPicking(false)}
      />
      <LazyBoundary
        resetKey={attempt}
        onError={(failure) => {
          retry();
          notifyLazyFailure(failure, lazyText);
        }}
      >
        <Body project={project} layout={layout} actions={actions} shortcuts={shortcuts} />
      </LazyBoundary>
    </section>
  );
}
