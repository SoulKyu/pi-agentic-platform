import type { PromptImageRef } from "@pap/contracts";
import type { Logger } from "../../kernel/logger.ts";
import type { AttachmentsPort } from "../files/index.ts";
import { type VmTarget, vmDelivery } from "./vm-attachments.ts";

/** What a prompt with attachments sends to its worker, and what to do once Pi has accepted it. */
export interface PreparedPrompt {
  readonly text: string;
  /** Absent when the prompt carries no image: the worker record then has no `images` field. */
  readonly images: readonly PromptImageRef[] | undefined;
  /** A VM session only (R33): the uploads go into the agent's inbox and the prompt names the VM paths instead of host paths. */
  readonly vm?: (target: VmTarget) => ReturnType<ReturnType<typeof vmDelivery>>;
  /** Pi accepted the prompt (M8R43): the pending images have been read, and the files are copied, so their uploads are spent (MC38 m3). */
  accepted(): void;
}

const announce = (text: string, paths: readonly string[]): string =>
  paths.length === 0
    ? text
    : `${text === "" ? "" : `${text}\n\n`}Attached files:\n${paths.map((path) => `- ${path}`).join("\n")}`;

/** A prompt with nothing attached: no await on its way, so the worker is asked for in the same turn as before M8. */
export const plainPrompt = (text: string): PreparedPrompt => ({
  text,
  images: undefined,
  accepted: () => {},
});

/**
 * Files are announced in the message and the agent reads them with its own tools (M8R42); images travel as paths the
 * worker reads itself (M8R41). What the owner attaches is the owner's own content: nothing here taints (M8R99).
 */
export function createPromptAttachments(deps: { attachments: AttachmentsPort; logger: Logger }) {
  return {
    /** Claims the uploads for this session and owner, or throws the store's refusal; the worker has not been asked yet. */
    async prepare(
      ownerId: string,
      sessionId: string,
      text: string,
      ids: readonly string[],
    ): Promise<PreparedPrompt> {
      const claimed = await deps.attachments.claim(ownerId, sessionId, ids);
      deps.logger.info("attachments_claimed", { images: claimed.images.length, files: claimed.files.length });
      return {
        text: announce(
          text,
          claimed.files.map((file) => file.path),
        ),
        vm: vmDelivery(text, claimed, announce),
        images:
          claimed.images.length === 0
            ? undefined
            : claimed.images.map(({ path, mimeType }) => ({ path, mimeType })),
        accepted: () =>
          deps.attachments.release(
            ownerId,
            [...claimed.images, ...claimed.files].map((attachment) => attachment.id),
          ),
      };
    },
  };
}
