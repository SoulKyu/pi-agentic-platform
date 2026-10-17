import { PUSH_ID } from "@pap/contracts";

const ID_BODY = PUSH_ID.source.slice(1, -1);
const LANDING_SEGMENT = /^\/n\/([^/]+)$/;
const OPEN_PATH = new RegExp(`^/n/${ID_BODY}$`);

/** The one segment of `/n/<segment>`, whatever it holds: the landing decides whether it is an id. */
export const landingSegmentOf = (path: string): string | null => LANDING_SEGMENT.exec(path)?.[1] ?? null;

/** The only paths the worker may ask the page to open: `/n/` and exactly the contracts' push id (M12R15, M12R33). */
export const isOpenPath = (path: string): boolean => OPEN_PATH.test(path);

export const isPushId = (id: string): boolean => PUSH_ID.test(id);
