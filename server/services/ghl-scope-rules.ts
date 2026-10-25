/**
 * Effective GHL export-scope rules (#2105). One definition shared by the scope SQL, the admin view and the native
 * review binding. The approval records a hash of these rules; a later change to any of them is a changed contract and
 * blocks writes until the owner records a new review.
 */
import crypto from "crypto";
import { pool } from "../db";

export const GHL_EXPORT_POLICY_KEY = "ghl_export_policy";
export const GHL_EXPORT_POLICY_DEFAULT_SINCE = "2026-10-23T04:00:00Z";
export const GHL_SCOPE_RULES_VERSION = 2;

/** Source categories that prove a person actually asked to be in the CRM (current intake). */
export const GHL_INTAKE_EVIDENCE_CATEGORIES = ["website_form", "partner_referral", "merchant_application", "manual_crm"] as const;

/**
 * Categories that may justify a create for an existing production contact without a post-cutoff event: the intake
 * categories plus the legitimate legacy lead sources (CSV/lead-file imports, discovered businesses, prospect
 * conversions and records the backfill labelled legacy_unknown).
 */
export const GHL_EXISTING_POPULATION_DEFAULT_CREATE_CATEGORIES = [
  ...GHL_INTAKE_EVIDENCE_CATEGORIES, "csv_import", "discovery", "prospect_conversion", "legacy_unknown",
] as const;

/** Raw registry loads are never an instruction to create contacts; policy can never name them. `registry_import` is the
 *  real contact-writer spelling; sunbiz/dbpr/registry are the event/category spellings. */
export const GHL_EXISTING_POPULATION_NEVER_CATEGORIES = ["sunbiz", "dbpr", "registry", "registry_import"] as const;

/** A source-less legacy prospect (no source event at all) is in scope for a create only when its lead_source label is
 *  present and is not a registry label. The label is the only provenance such rows carry; none is fabricated. */
export const GHL_SOURCE_LESS_REGISTRY_LABEL_PATTERN = "^(sunbiz|dbpr|registry)";

export interface GhlScopeRules {
  version: number;
  enabled: boolean;
  productionOnly: true;
  createSourceCategories: string[];
  neverCategories: string[];
  sourceLessLegacy: boolean;
  currentIntakeSince: string;
}

export function effectiveGhlScopeRules(rawPolicy: unknown): GhlScopeRules {
  const policy = (rawPolicy && typeof rawPolicy === "object" ? rawPolicy : {}) as any;
  const existing = policy.existingPopulation && typeof policy.existingPopulation === "object" ? policy.existingPopulation : {};
  const never = new Set<string>(GHL_EXISTING_POPULATION_NEVER_CATEGORIES);
  const configured: unknown[] | null = Array.isArray(existing.createSourceCategories) ? existing.createSourceCategories : null;
  const categories = (configured ?? [...GHL_EXISTING_POPULATION_DEFAULT_CREATE_CATEGORIES])
    .filter((c): c is string => typeof c === "string" && c.length > 0 && !never.has(c));
  return {
    version: GHL_SCOPE_RULES_VERSION,
    enabled: existing.enabled !== false,
    productionOnly: true,
    createSourceCategories: Array.from(new Set(categories)).sort(),
    neverCategories: Array.from(never).sort(),
    sourceLessLegacy: existing.sourceLessLegacy !== false,
    currentIntakeSince: typeof policy.currentIntakeSince === "string" ? policy.currentIntakeSince : GHL_EXPORT_POLICY_DEFAULT_SINCE,
  };
}

/** JSON with recursively sorted keys: hashes must survive a jsonb round trip, which reorders object keys. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item === undefined ? null : item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as object).sort().filter(k => (value as any)[k] !== undefined)
      .map(k => `${JSON.stringify(k)}:${stableStringify((value as any)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function hashGhlScopeRules(rules: GhlScopeRules): string {
  return crypto.createHash("sha256").update(stableStringify(rules)).digest("hex");
}

export async function readGhlScopeRules(): Promise<GhlScopeRules> {
  const row = (await pool.query(`SELECT value FROM system_settings WHERE key = $1`, [GHL_EXPORT_POLICY_KEY])).rows[0]?.value;
  return effectiveGhlScopeRules(typeof row === "string" ? JSON.parse(row) : row);
}

export async function readGhlScopeRulesRevision(): Promise<string> {
  return hashGhlScopeRules(await readGhlScopeRules());
}
