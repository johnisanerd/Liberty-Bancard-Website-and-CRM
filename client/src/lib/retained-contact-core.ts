/**
 * The Contact core (header facts and capabilities) is shown while a section loads, but only for the exact
 * protected actor scope and contact it was read for. Any error, other actor, other permission generation or other
 * record drops it, so a header can never outlive the authority that produced it.
 */
export interface RetainedCoreSource<T> { data?: T | null; hasCore: boolean; error?: unknown }

export class RetainedContactCore<T> {
  private entry: { key: string; data: T } | null = null;

  static key(scope: unknown, contactId: number | string) {
    return `${JSON.stringify(scope)}:${contactId}`;
  }

  /** Call with the current render's key and the read answering that same key. Late answers for other keys never arrive here. */
  observe(key: string, source: RetainedCoreSource<T>): void {
    if (source.error) { this.entry = null; return; }
    if (source.hasCore && source.data != null) { this.entry = { key, data: source.data }; return; }
    if (this.entry && this.entry.key !== key) this.entry = null;
  }

  /** The retained core for this key, or null. */
  read(key: string): T | null {
    return this.entry?.key === key ? this.entry.data : null;
  }
}
