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

/**
 * The only shape retained across section reads: contact core and capability flags. Section arrays (deals, tickets, tasks,
 * notes), loaded flags and any other part of the detail response are never copied into the retained value, so a section
 * payload cannot be shown for a different section, actor or record.
 */
export interface ContactCoreProjection<C, Cap> { contact: C; capabilities: Cap | undefined }
export function projectContactCore<C, Cap>(detail: { contact?: C | null; capabilities?: Cap } | null | undefined): ContactCoreProjection<C, Cap> | null {
  if (!detail?.contact) return null;
  return { contact: detail.contact, capabilities: detail.capabilities };
}
