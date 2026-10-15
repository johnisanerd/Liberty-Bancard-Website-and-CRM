/** Paginated per-upload original-coordinate ledger. Rows, distinct contacts,
 * verified links and receipts are separate facts and are never summed. */
export type UploadReceiptStatus = "current" | "stale" | "inconsistent" | "none";

export interface UploadLedgerRun {
  executionId: string;
  importType: string;
  fileName: string | null;
  status: string;
  startedAt: string | null;
  totalRows: number | null;
  accountedRows: number;
}

export interface UploadLedgerSummary {
  executionId: string;
  rows: number;
  byDisposition: Record<string, number>;
  /** Distinct contacts with original-row provenance in this upload. */
  distinctContacts: number;
  /** Of those contacts, the ones whose current business is a verified audited decision. */
  verifiedLinks: number;
  /** Items carrying a receipt valid for coordinate, fingerprint and qualification version. */
  receiptsCurrent: number;
  /** Receipts for the same coordinate/fingerprint under an older qualification version. */
  receiptsStale: number;
  /** Receipts whose coordinate or fingerprint disagree with the original accounting. */
  receiptsInconsistent: number;
  qualificationVersion: string;
  observedAt: string;
}

export interface UploadLedgerMailbox {
  email: string;
  contactId: number | null;
  /** The contact has a provenance event for this exact original row and fingerprint. */
  hasProvenance: boolean;
  businessId: number | null;
  verifiedLink: boolean;
}

export interface UploadLedgerRow {
  sourceRowNumber: number;
  disposition: string;
  reasonCode: string;
  rowFingerprint: string;
  fulfillmentState: string | null;
  nextAttemptAt: string | null;
  completedAt: string;
  originalFormat: "raw-v3" | "raw-v2" | "execution_payload" | null;
  sourceCoordinate: unknown | null;
  companyName: string | null;
  businessOnly: boolean;
  mailboxes: UploadLedgerMailbox[];
  /** Provenance contacts that are not one of the original row's mailboxes. */
  unexpectedContactIds: number[];
  receipt: { status: UploadReceiptStatus; qualificationVersion: string | null };
}

export interface UploadLedgerPage {
  executionId: string;
  rows: UploadLedgerRow[];
  /** Pass as `after` for the next page; null when the upload is exhausted. */
  nextAfter: number | null;
  limit: number;
  filter: "all" | "unfulfilled";
  observedAt: string;
}
