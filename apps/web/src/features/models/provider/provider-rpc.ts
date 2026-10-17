import type { ProviderGetResult } from "@pap/contracts";
import type { z } from "zod";
import { getRuntime } from "../../../runtime/index.ts";

/** The provider methods (get, save, remove) as the runtime's typed client calls them. */
export type GetResult = z.infer<typeof ProviderGetResult>;

export const providerRpc = () => getRuntime().rpc;
