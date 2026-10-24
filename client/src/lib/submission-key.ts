/**
 * Idempotency key that survives a lost response, an unreadable body and a page reload.
 *
 * A key is kept (per form and mailbox) until the server gives a definitive answer. A retry after a crash then replays
 * the same occurrence, so the server can finish the work it already committed instead of treating it as a new
 * application. Falls back to an in-memory key when session storage is unavailable.
 */
const memory = new Map<string, string>();

function storageKey(scope: string, identity: string): string {
  return `lb-submission-key:${scope}:${identity.trim().toLowerCase()}`;
}

export function getSubmissionKey(scope: string, identity: string): string {
  const k = storageKey(scope, identity);
  try {
    const existing = window.sessionStorage.getItem(k);
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    window.sessionStorage.setItem(k, fresh);
    return fresh;
  } catch {
    const existing = memory.get(k);
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    memory.set(k, fresh);
    return fresh;
  }
}

export function clearSubmissionKey(scope: string, identity: string): void {
  const k = storageKey(scope, identity);
  memory.delete(k);
  try { window.sessionStorage.removeItem(k); } catch { /* storage unavailable */ }
}

/**
 * True when the answer settles the occurrence (success, a rejection that recorded nothing, or a failed previous
 * attempt that needs a fresh key). Server errors and unreadable bodies are not definitive: keep the key and retry.
 */
export function isDefinitiveSubmissionOutcome(status: number, body: { error?: string } | null): boolean {
  if (status >= 200 && status < 300) return body !== null;
  if (status === 409 || status === 400 || status === 404 || status === 422 || status === 429) return true;
  return false;
}
