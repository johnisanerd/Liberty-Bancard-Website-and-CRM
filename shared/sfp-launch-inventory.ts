/**
 * Launch inventory: the current canonical recipients re-checked against every launch
 * requirement. Observational only. A recipient counted here is not authorized to send;
 * sending stays held until an operator releases it.
 */
export type LaunchGateKey =
  | "contact_current" | "address_unchanged" | "business_link_current" | "business_current"
  | "accepted_vertical" | "sequence_bound" | "in_territory" | "fresh_validation"
  | "paused_membership" | "contact_policy" | "prepared_facts_current";

export const LAUNCH_GATE_LABELS: Record<LaunchGateKey, string> = {
  contact_current: "Contact is a current, unsuppressed production contact",
  address_unchanged: "Email address is unchanged since it was prepared",
  business_link_current: "Contact has a current verified link to its business",
  business_current: "Business is a current canonical business",
  accepted_vertical: "Business has a current accepted vertical in the program",
  sequence_bound: "A live sequence is bound to that vertical",
  in_territory: "Business is in Broward, Miami-Dade or Palm Beach",
  fresh_validation: "A fresh valid address validation is on file",
  paused_membership: "The owned sequence membership exists and is paused",
  contact_policy: "Consent, hygiene and promotion rules allow an email",
  prepared_facts_current: "Recorded preparation still matches current records, including the package version",
};

export interface LaunchReasonCount { gate: LaunchGateKey; code: string; label: string; count: number }

export interface LaunchCountyVerticalCell { county: string; vertical: string; businesses: number; recipients: number }

export interface LaunchInventoryPopulation {
  /** Preparation records in this state. */
  recorded: number;
  /** Records that pass every requirement right now. */
  qualified: number;
  /** Distinct businesses among qualified records. */
  qualifiedBusinesses: number;
  /** One primary recipient per qualified business; the rest are held as alternates. */
  primaryRecipients: number;
  alternates: number;
  blocked: LaunchReasonCount[];
}

export interface LaunchReleaseBlocker {
  key: string;
  label: string;
  state: "blocked" | "ok" | "unknown";
  detail: string;
}

export interface SfpLaunchInventory {
  observedAt: string;
  maxAgeSeconds: number;
  readyHeld: LaunchInventoryPopulation;
  pendingValidation: LaunchInventoryPopulation;
  byCountyAndVertical: LaunchCountyVerticalCell[];
  sender: {
    usableIdentities: number;
    totalIdentities: number;
    dailyCapacity: number;
    sentToday: number;
    /** Days of first-touch messages the primary recipients represent at the current daily capacity; null when capacity is 0. */
    daysOfFirstTouches: number | null;
  };
  releaseBlockers: LaunchReleaseBlocker[];
  notes: string[];
}
