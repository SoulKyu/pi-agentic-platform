import type { VmdResponse } from "@pap/contracts";

/** The contracts export the schema only: the types come from what it parses to. */
export type VmdResponseBody = ReturnType<(typeof VmdResponse)["parse"]>;
export type VmdCode = Extract<VmdResponseBody, { ok: false }>["code"];

/** What an operation throws to answer a typed refusal; anything else it throws answers `failed`. */
export class VmdFailure extends Error {
  readonly code: VmdCode;
  constructor(code: VmdCode) {
    super(code);
    this.code = code;
  }
}
