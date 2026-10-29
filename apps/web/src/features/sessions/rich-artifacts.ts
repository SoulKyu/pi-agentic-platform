import { fenceIndexAt, scanFences } from "@pap/contracts";
import type { RichReplies } from "@pap/ui";
import { errorKey, type Translate } from "../../i18n/index.ts";
import { getRuntime, RpcError } from "../../runtime/index.ts";

/**
 * PREVIEW for a finished message's html fences (UX2-R50). The renderer hands over the offset of a fence in the message
 * text; the index is counted among the top-level fences with the same scanner the daemon reads the reply with, and the
 * daemon takes the fence from the stored entry itself (`previews.artifact {sessionId, entryId, fenceIndex}`): the browser
 * never sends the HTML. A fence that is not top-level, or whose scanned body is not the code shown, has no index, so no button and no call. A refusal rejects with the
 * app's own text for its code.
 */
export function artifactOf(
  sessionId: string,
  entryId: string,
  text: string,
  t: Translate,
): Required<Pick<RichReplies, "artifact" | "canArtifact">> {
  // Fails closed: the fence must be top-level AND its scanned body the code the reply renders. A fence inside a list item
  // renders as that item's code while the scanner (up to 3 spaces of indent) may read a longer body.
  const indexOf = (offset: number, code: string): number | null => {
    const index = fenceIndexAt(text, offset);
    return index !== null && scanFences(text)[index]?.body === code ? index : null;
  };
  return {
    canArtifact: (offset, code) => indexOf(offset, code) !== null,
    async artifact(offset, code) {
      const fenceIndex = indexOf(offset, code);
      if (fenceIndex === null) throw new Error(t(errorKey("not_found")));
      const { rpc } = getRuntime();
      try {
        const { url } = await rpc.call(
          "previews.artifact",
          { sessionId, entryId, fenceIndex },
          { commandId: rpc.newCommandId() },
        );
        return url;
      } catch (failure) {
        throw new Error(t(errorKey(failure instanceof RpcError ? failure.code : "internal")), {
          cause: failure,
        });
      }
    },
  };
}
