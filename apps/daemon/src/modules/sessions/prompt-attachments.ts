import type { PromptImageRef } from "@pap/contracts";
import type { Logger } from "../../kernel/logger.ts";
import type { AttachmentsPort } from "../files/index.ts";

/** What a prompt with attachments sends to its worker, and what to do once Pi has accepted it. */
export interface PreparedPrompt {
  readonly text: string;
  /** Absent when the prompt carries no image: the worker record then has no `images` field. */
  readonly images: readonly PromptImageRef[] | undefined;
  /** Pi accepted the prompt (M8R43): the pending images have been read, and the files are copied, so their uploads are spent (MC38 m3). */
  accepted(): void;
}

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
      const list = claimed.files.map((file) => `- ${file.path}`).join("\n");
      const announced = list === "" ? text : `${text === "" ? "" : `${text}\n\n`}Attached files:\n${list}`;
      return {
        text: announced,
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
