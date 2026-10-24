import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { Logger } from "../../kernel/logger.ts";
import { BUILD_NOTICE } from "./image-policy.ts";
import type { KataImages } from "./kata-images.ts";

const Saved = z.object({
  version: z.literal(1),
  projects: z.record(
    z.string(),
    z.object({ built: z.array(z.string()), wanted: z.array(z.string()).nullable() }),
  ),
});

export interface ProjectImagesDeps {
  readonly images: Pick<KataImages, "resolve" | "forget">;
  readonly logger: Pick<Logger, "warn">;
  /** Posts once into the project's live sessions (the same router as the images' notices). */
  readonly notice: (projectId: string, text: string) => void;
  /** Where the packages of each project are kept across restarts (`$PAP_HOME/vm/project-images.json`). */
  readonly file: string;
}

export interface ProjectImages {
  /**
   * The image a project's box starts with: the profile image while the project has no built packages (the profile layer is
   * every box's), else the layer built from them. A start builds a missing image first, so it may take minutes.
   */
  tagOf(projectId: string): Promise<string>;
  /** What `.pi/project.yaml` asks for, as the box's last `project.config` answered; `null` leaves it as it was. */
  setWanted(projectId: string, wanted: readonly string[]): void;
  /**
   * Builds the image of the wanted packages and answers when it exists. A box that runs (`running`) keeps its image and its
   * sessions get the notice; the new tag applies at its next start. `built` changes only once the image is ready: a failed
   * build leaves it as it was, is logged, and throws.
   */
  rebuild(projectId: string, running: boolean): Promise<void>;
  packages(projectId: string): {
    readonly built: readonly string[];
    readonly wanted: readonly string[] | null;
  };
  /** The project is deleted: what is kept of it goes. */
  forget(projectId: string): void;
}

const buildKeyOf = (projectId: string): string => `${projectId}:build`;

interface State {
  built: readonly string[];
  wanted: readonly string[] | null;
}

export function createProjectImages(deps: ProjectImagesDeps): ProjectImages {
  const states = new Map<string, State>(Object.entries(read(deps)));
  const stateOf = (projectId: string): State => {
    let state = states.get(projectId);
    if (state === undefined) {
      state = { built: [], wanted: null };
      states.set(projectId, state);
    }
    return state;
  };
  const save = (): void => {
    try {
      mkdirSync(dirname(deps.file), { recursive: true, mode: 0o700 });
      writeFileSync(
        `${deps.file}.tmp`,
        JSON.stringify({ version: 1, projects: Object.fromEntries(states) }),
        {
          mode: 0o600,
        },
      );
      renameSync(`${deps.file}.tmp`, deps.file);
    } catch (error) {
      deps.logger.warn("project_images_save_failed", { err: error });
    }
  };
  return {
    tagOf: (projectId) => deps.images.resolve(projectId, stateOf(projectId).built, "thread"),
    setWanted(projectId, wanted) {
      const state = stateOf(projectId);
      if (state.wanted?.join("\n") === wanted.join("\n")) return;
      state.wanted = [...wanted];
      save();
    },
    async rebuild(projectId, running) {
      const state = stateOf(projectId);
      const next = state.wanted ?? state.built;
      if (running) deps.notice(projectId, BUILD_NOTICE);
      try {
        // A key that never runs: the policy has no old image to fall back on, so it builds and waits for the tag.
        await deps.images.resolve(buildKeyOf(projectId), next, "thread");
      } catch (error) {
        deps.logger.warn("project_image_build_failed", { projectId, err: error });
        throw error;
      }
      state.built = [...next];
      save();
    },
    packages(projectId) {
      const state = stateOf(projectId);
      return { built: state.built, wanted: state.wanted };
    },
    forget(projectId) {
      deps.images.forget(projectId);
      deps.images.forget(buildKeyOf(projectId));
      if (states.delete(projectId)) save();
    },
  };
}

function read(deps: ProjectImagesDeps): Record<string, State> {
  try {
    return Saved.parse(JSON.parse(readFileSync(deps.file, "utf8"))).projects;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      deps.logger.warn("project_images_unreadable", { err: error });
    return {};
  }
}
