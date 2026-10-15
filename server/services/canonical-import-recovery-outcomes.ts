/** Only confirmed PostgreSQL transaction aborts may yield to another row.
 * Connection failures, unknown commit results and authority denials are fatal.
 * Do not classify an error as recoverable merely because cleanup succeeded. */
export function isRecoverableImportRowFailure(error: unknown): boolean {
  let current: any = error;
  for (let depth = 0; current && depth < 6; depth++, current = current.cause) {
    if (typeof current.code==="string" &&
        (/^08/.test(current.code) || ["57P01","57P02","57P03","25P03","ECONNRESET","EPIPE",
          "ETIMEDOUT","ECONNREFUSED","ECONNABORTED","ENETUNREACH","EHOSTUNREACH"].includes(current.code))) {
      return false;
    }
    // Drizzle's "Failed query" wrapper echoes the statement text. Its SQL may
    // legitimately contain a fatal reason literal (for example a predicate over
    // a hold code); the real database error is classified on its own cause.
    if (typeof current.message === "string" && !current.message.startsWith("Failed query:") &&
        /(?:FENCE_LOST|LEASE_LOST|OWNER_CHANGED|OWNER_BLOCKED|HANDOFF_|GUARD_MISSING|FINGERPRINT_MISMATCH)/.test(current.message)) {
      return false;
    }
  }
  current = error;
  for (let depth = 0; current && depth < 6; depth++, current = current.cause) {
    if (["55P03", "40P01", "40001", "23505", "23502", "23503"].includes(current.code)) return true;
  }
  return false;
}

export class CanonicalImportRecoveryFailure extends Error {
  readonly cleanupError: unknown;
  readonly failureId: string;
  authorityError?: unknown;
  constructor(failure: {originalError: unknown; cleanupError?: unknown; failureId: string}) {
    super("CANONICAL_IMPORT_RECOVERY_ABORTED", {cause: failure.originalError});
    this.name = "CanonicalImportRecoveryFailure";
    this.cleanupError = failure.cleanupError;
    this.failureId = failure.failureId;
  }
}
