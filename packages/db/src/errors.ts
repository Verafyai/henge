/** API-facing errors from the data layer: an HTTP status, a stable code and a plain message. */
export class MembershipError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** A refused ledger movement (SPEC 9.5). */
export class LedgerError extends MembershipError {}
