/**
 * Wave 6 — Sequence Eligibility Helpers
 *
 * canEnrollContactInSequence()   — consent-tier + lifecycle + family-specific guard
 * suggestSequenceFamiliesForContact() — offer-route-driven ranked suggestions
 */

import { storage } from "../storage";

export interface EnrollmentEligibilityResult {
  allowed: boolean;
  reason?: string;
  contactConsentTier?: string;
  eligibleConsentTiers?: string[];
  campaignFamily?: string;
}

export interface SequenceSuggestion {
  sequenceFamily: string;
  sequenceName?: string;
  sequenceId?: number;
  reason: string;
  priority: number;
}

/**
 * Determine whether a contact may be enrolled in a given sequence.
 *
 * Checks (in order):
 *  1. Contact exists
 *  2. Contact is not DNC / doNotContact (hard block)
 *  3. Contact consent tier is not opted_out / do_not_contact
 *  4. Consent tier is compatible with `eligibleConsentTiers`
 *     — if the column is null/empty we allow any tier (legacy sequence)
 *  5. Lifecycle stage is compatible with `lifecycleStagesAllowed`
 *     — if null/empty we allow any stage
 *  6. Family-specific guards:
 *     — partner-referral: contact MUST have partnerType AND partnerOrgId set
 *     (add further specialized guards here for future families)
 *
 * IMPORTANT: a sequence that includes SMS steps but also lists `warm_no_pewc`
 * in `eligibleConsentTiers` MUST allow warm_no_pewc enrollment.  SMS steps for
 * non-PEWC contacts are skipped at worker Gate (b) at execution time.
 * This function must NOT over-block on channel presence alone.
 */
export async function canEnrollContactInSequence(
  contactId: number,
  sequence: {
    id?: number;
    name?: string | null;
    status?: string | null;
    sequenceFamily?: string | null;
    eligibleConsentTiers?: string[] | null;
    lifecycleStagesAllowed?: string[] | null;
  },
  /** Callers testing many sequences against one contact pass it once instead of re-reading it per sequence. */
  preloadedContact?: Awaited<ReturnType<typeof storage.getContact>>
): Promise<EnrollmentEligibilityResult> {
  return evaluateEnrollmentEligibility(preloadedContact ?? await storage.getContact(contactId), sequence);
}

/**
 * Pure eligibility decision over an already-loaded contact. Callers that test many sequences against one contact
 * load it once and call this, instead of re-reading the contact per sequence.
 */
export function evaluateEnrollmentEligibility(
  contact: Awaited<ReturnType<typeof storage.getContact>> | undefined | null,
  sequence: {
    id?: number;
    name?: string | null;
    status?: string | null;
    sequenceFamily?: string | null;
    eligibleConsentTiers?: string[] | null;
    lifecycleStagesAllowed?: string[] | null;
  }
): EnrollmentEligibilityResult {
  if (!contact) {
    return { allowed: false, reason: "Contact not found." };
  }

  if (contact.doNotContact) {
    return {
      allowed: false,
      reason: "Contact is marked Do Not Contact.",
      contactConsentTier: contact.consentTier ?? undefined,
      eligibleConsentTiers: sequence.eligibleConsentTiers ?? undefined,
      campaignFamily: sequence.sequenceFamily ?? undefined,
    };
  }

  const contactTier = contact.consentTier ?? "cold_no_consent";
  if (contactTier === "opted_out" || contactTier === "do_not_contact") {
    return {
      allowed: false,
      reason: `Contact consent tier is ${contactTier} — blocked from all automated sequences.`,
      contactConsentTier: contactTier,
      eligibleConsentTiers: sequence.eligibleConsentTiers ?? undefined,
      campaignFamily: sequence.sequenceFamily ?? undefined,
    };
  }

  const tiers = sequence.eligibleConsentTiers;
  if (tiers && tiers.length > 0) {
    if (!tiers.includes(contactTier)) {
      return {
        allowed: false,
        reason: `Contact consent tier "${contactTier}" is not in the sequence's eligible tiers [${tiers.join(", ")}].`,
        contactConsentTier: contactTier,
        eligibleConsentTiers: tiers,
        campaignFamily: sequence.sequenceFamily ?? undefined,
      };
    }
  }

  const stages = sequence.lifecycleStagesAllowed;
  if (stages && stages.length > 0) {
    const contactStage = contact.lifecycleStage ?? "prospect";
    if (!stages.includes(contactStage)) {
      return {
        allowed: false,
        reason: `Contact lifecycle stage "${contactStage}" is not in the sequence's allowed stages [${stages.join(", ")}].`,
        contactConsentTier: contactTier,
        eligibleConsentTiers: sequence.eligibleConsentTiers ?? undefined,
        campaignFamily: sequence.sequenceFamily ?? undefined,
      };
    }
  }

  // Family-specific guards
  const family = sequence.sequenceFamily;
  if (family === "partner-referral") {
    const partnerType = (contact as any).partnerType ?? null;
    const partnerOrgId = (contact as any).partnerOrgId ?? null;
    if (!partnerType || !partnerOrgId) {
      return {
        allowed: false,
        reason: "The partner-referral sequence requires the contact to have partnerType and partnerOrgId set.",
        contactConsentTier: contactTier,
        eligibleConsentTiers: sequence.eligibleConsentTiers ?? undefined,
        campaignFamily: family,
      };
    }
  }

  return {
    allowed: true,
    contactConsentTier: contactTier,
    eligibleConsentTiers: sequence.eligibleConsentTiers ?? undefined,
    campaignFamily: family ?? undefined,
  };
}

/**
 * Returns true when a sequence has at least one email step.
 * Used by enrollment routes to decide whether to run the email-channel
 * contactability check before enrolling a contact.
 *
 * Email-only suppressions (bounced, invalid, unsafe, blocked, opted_out) must
 * NOT block enrollment into SMS-only or manual-task sequences — this helper
 * lets callers apply the check only when it's relevant.
 */
export async function sequenceHasEmailSteps(sequenceId: number): Promise<boolean> {
  const steps = await storage.getSequenceSteps(sequenceId);
  return steps.some(s => (s as any).actionType === "email");
}

/**
 * Offer-route-to-family mapping.
 *
 * Each offer path maps to an ordered list of Wave 6 sequence family keys
 * (most specific first).  The suggestion engine walks this map first, then
 * falls back to tier/stage/partner heuristics for contacts without a
 * resolved offerPath.
 */
const OFFER_ROUTE_FAMILY_MAP: Record<string, Array<{ family: string; reason: string; priority: number }>> = {
  statement_review: [
    { family: "statement-uploaded",       reason: "Contact's primary offer is statement review — enroll in the statement-uploaded follow-up sequence.", priority: 80 },
    { family: "cold-email-manual-call",   reason: "Statement-review offer path: cold outreach + manual call sequence as a secondary option.", priority: 30 },
  ],
  rate_reduction: [
    { family: "cold-email-manual-call",   reason: "Rate-reduction offer path: cold outreach email + manual call task sequence.", priority: 70 },
    { family: "inbound-no-pewc",          reason: "Rate-reduction inbound lead: consent-safe follow-up sequence.", priority: 60 },
    { family: "proposal-sent",            reason: "Rate-reduction offer path: proposal follow-up sequence.", priority: 55 },
  ],
  high_risk: [
    { family: "inbound-no-pewc",          reason: "High-risk offer path: inbound consent-safe sequence to qualify and build trust.", priority: 65 },
    { family: "cold-email-manual-call",   reason: "High-risk cold outreach: email + manual call to open the conversation.", priority: 40 },
  ],
  fast_approval: [
    { family: "application-abandoned",   reason: "Fast-approval offer path: recover abandoned application.", priority: 75 },
    { family: "inbound-no-pewc",          reason: "Fast-approval inbound: consent-safe follow-up to drive application completion.", priority: 55 },
  ],
  onboarding: [
    { family: "closed-won-onboarding",   reason: "Onboarding offer path: closed-won merchant onboarding sequence.", priority: 90 },
  ],
  referral: [
    { family: "merchant-referral",        reason: "Referral offer path: invite live merchant to refer other businesses.", priority: 85 },
  ],
  partner_program: [
    { family: "partner-referral",         reason: "Partner-program offer path: partner referral welcome and activation sequence.", priority: 95 },
  ],
  iso_residual: [
    { family: "partner-referral",         reason: "ISO residual offer path: partner referral sequence for ISO/agent contacts.", priority: 90 },
  ],
};

/**
 * Suggest Wave 6 sequence families for a contact based on their current
 * primaryOfferPath (Wave 5), consent tier, lifecycle stage, source category,
 * and partner type/orgId.
 *
 * Returns an array sorted by descending priority.
 * Does NOT create any enrollments.
 */
export async function suggestSequenceFamiliesForContact(contactId: number): Promise<SequenceSuggestion[]> {
  const contact = await storage.getContact(contactId);
  if (!contact) return [];

  if (contact.doNotContact) return [];
  const tier = contact.consentTier ?? "cold_no_consent";
  if (tier === "opted_out" || tier === "do_not_contact") return [];

  const stage = contact.lifecycleStage ?? "prospect";
  const offerPath = (contact as any).primaryOfferPath as string | null;
  const partnerType = (contact as any).partnerType ?? null;
  const partnerOrgId = (contact as any).partnerOrgId ?? null;

  const seen = new Set<string>();
  const suggestions: SequenceSuggestion[] = [];

  function add(family: string, reason: string, priority: number) {
    if (!seen.has(family)) {
      seen.add(family);
      suggestions.push({ sequenceFamily: family, reason, priority });
    }
  }

  // --- 1. Offer-route-driven suggestions (highest specificity) ---
  if (offerPath && OFFER_ROUTE_FAMILY_MAP[offerPath]) {
    for (const entry of OFFER_ROUTE_FAMILY_MAP[offerPath]) {
      // Respect lifecycle guard: partner-referral requires partnerType+partnerOrgId
      if (entry.family === "partner-referral" && (!partnerType || !partnerOrgId)) continue;
      // Respect lifecycle guard: closed-won-onboarding / merchant-referral require live_merchant
      if ((entry.family === "closed-won-onboarding" || entry.family === "merchant-referral") && stage !== "live_merchant") continue;
      add(entry.family, entry.reason, entry.priority);
    }
  }

  // --- 2. Partner guard (highest priority when partner signals are present) ---
  if (partnerType && partnerOrgId) {
    add("partner-referral", "Contact is an active partner (partnerType + partnerOrgId set) — enroll in partner referral sequence.", 100);
  }

  // --- 3. Lifecycle-stage-driven suggestions ---
  if (stage === "live_merchant") {
    add("merchant-referral", "Live merchant is eligible for the referral program.", 90);
    add("closed-won-onboarding", "Recently closed-won merchant may need onboarding follow-up.", 85);
  }

  if (stage === "statement_uploaded") {
    add("statement-uploaded", "Contact uploaded a statement — follow up with the statement-analysis sequence.", 80);
  }

  if (stage === "call_booked") {
    add("booked-appointment", "Contact has a booked call — send appointment confirmation sequence.", 75);
  }

  if (stage === "proposal_sent") {
    add("proposal-sent", "Proposal was sent — follow up with decision-support sequence.", 70);
  }

  // --- 4. Tier-driven fallbacks ---
  if (tier === "warm_no_pewc" || tier === "pewc_full_automation") {
    add("inbound-no-pewc",       "Warm inbound contact — enroll in consent-safe follow-up sequence.", 60);
    add("no-show-recovery",      "Suitable for no-show or missed-appointment recovery.", 50);
    add("application-abandoned", "Suitable for application-abandoned recovery.", 45);
  }

  if (tier === "cold_no_consent" || tier === "warm_no_pewc" || tier === "pewc_full_automation") {
    add("cold-email-manual-call", "Default cold outreach sequence with manual call task steps.", 30);
  }

  suggestions.sort((a, b) => b.priority - a.priority);

  // Resolve sequenceId + sequenceName from live DB
  const sequences = await storage.getFollowUpSequences();
  const familyMap = new Map<string, { id: number; name: string }>();
  for (const seq of sequences) {
    const sf = (seq as any).sequenceFamily;
    if (sf && !familyMap.has(sf)) {
      familyMap.set(sf, { id: seq.id, name: seq.name });
    }
  }

  return suggestions.map(s => ({
    ...s,
    sequenceId: familyMap.get(s.sequenceFamily)?.id,
    sequenceName: familyMap.get(s.sequenceFamily)?.name,
  }));
}
