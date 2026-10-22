/**
 * Return context for record pages. The originating list URL (with its filters) is remembered per signed-in user in
 * this tab's session storage and re-validated on read, so a Back control never navigates to another actor's saved
 * list or to an arbitrary path.
 */
export type ReturnKind = "people" | "inventory";
const PATTERNS: Record<ReturnKind, RegExp> = {
  people: /^\/dashboard\/contacts(?:-leads)?(?:\?[A-Za-z0-9_%=&.,:+~-]{0,1500})?$/,
  inventory: /^\/dashboard\/lead-ops\?[A-Za-z0-9_%=&.,:+~-]{0,1500}$/,
};
const key = (kind: ReturnKind, actorId: string) => `crm:return:${kind}:${actorId}`;

export function isValidReturnUrl(kind: ReturnKind, url: string): boolean {
  return PATTERNS[kind].test(url);
}
export function rememberReturnUrl(kind: ReturnKind, actorId: string | undefined, url: string): void {
  if (!actorId || !isValidReturnUrl(kind, url)) return;
  try { window.sessionStorage.setItem(key(kind, actorId), url); } catch { /* storage unavailable: Back falls back to the default list */ }
}
export function readReturnUrl(kind: ReturnKind, actorId: string | undefined): string | null {
  if (!actorId) return null;
  try {
    const url = window.sessionStorage.getItem(key(kind, actorId));
    return url && isValidReturnUrl(kind, url) ? url : null;
  } catch { return null; }
}
