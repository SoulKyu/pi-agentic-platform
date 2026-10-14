import { PapError } from "@pap/contracts";
import type { AttachmentsPort } from "../../files/index.ts";

/** No upload exists: every claim is refused as the real store refuses an unknown id. */
export const noAttachments: AttachmentsPort = {
  claim: () => Promise.reject(new PapError("not_found")),
  release: () => {},
};
