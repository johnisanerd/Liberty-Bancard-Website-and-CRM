/**
 * Dependency-free wording checks shared by the retained-copy audit script and the template publish route.
 * Pure functions only: no database, no network, no environment access.
 */

export const SUPPORTED_MERGE = new Set([
  "firstName", "lastName", "fullName", "email", "phone", "companyName", "businessName", "agentName", "agentEmail",
  "agentPhone", "calendarLink", "dealName", "referenceId",
]);

export const COPY_RULES: Array<{ id: string; test: RegExp; why: string }> = [
  { id: "bracket_placeholder", test: /\[[A-Z][A-Z0-9_]{3,}\]/g, why: "Unresolved bracket placeholder would be sent literally" },
  { id: "dead_link", test: /href=["']#["']/gi, why: "Link has no destination" },
  { id: "attachment_ask", test: /(reply|respond)[^.]{0,60}attach|attach[^.]{0,60}(voided check|driver'?s? licen[sc]e|photo id|identification)|email[^.]{0,40}(voided check|photo id|driver'?s? licen[sc]e)/gi, why: "Asks the recipient to email sensitive documents; use the secure upload journey" },
  { id: "unsupported_timing", test: /within\s+(1|one)\s+business\s+day|in\s+(just\s+)?5\s+minutes|same[- ]day|guaranteed/gi, why: "Timing or guarantee not backed by a recorded policy" },
  { id: "unsupported_proof", test: /\b(thousands of merchants|trusted by \d|saved (our|my) clients|average (savings|saving) of)\b/gi, why: "Social-proof or savings claim without a stored source" },
  { id: "exists_claim", test: /(your analysis (is|has been) saved|your application (is|has been) approved|agreement (is|was) sent)/gi, why: "States a record exists without a recorded event" },
];

export interface CopyFinding { rule: string; match: string; why: string }

export function mergeVariables(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g)].map((m) => m[1]);
}

export function lintCopy(text: string): CopyFinding[] {
  const out: CopyFinding[] = [];
  for (const rule of COPY_RULES) {
    const hits = [...text.matchAll(new RegExp(rule.test.source, rule.test.flags))].map((m) => m[0].slice(0, 80));
    for (const hit of new Set(hits)) out.push({ rule: rule.id, match: hit, why: rule.why });
  }
  for (const v of new Set(mergeVariables(text))) {
    if (!SUPPORTED_MERGE.has(v) && !/^(contact|deal|company|agent)\.[A-Za-z0-9_]+$/.test(v)) {
      out.push({ rule: "unknown_merge_variable", match: `{{${v}}}`, why: "Variable is not in the supported merge list" });
    }
  }
  return out;
}

/** Sample values used only to render a preview; nothing here is sent or stored. */
export const PREVIEW_SAMPLE: Record<string, string> = {
  "contact.firstName": "Alex", "contact.lastName": "Sample", "contact.email": "alex@example.test",
  "contact.phone": "(555) 010-0100", "contact.companyName": "Sample Business LLC", "contact.vertical": "restaurant",
  firstName: "Alex", lastName: "Sample", fullName: "Alex Sample", email: "alex@example.test", phone: "(555) 010-0100",
  companyName: "Sample Business LLC", businessName: "Sample Business LLC", agentName: "Sample Representative",
  agentEmail: "rep@example.test", agentPhone: "(555) 010-0101", calendarLink: "https://example.test/book",
  dealName: "Sample deal", referenceId: "ABCD1234",
};

export function renderPreview(text: string): { rendered: string; unresolved: string[] } {
  const unresolved: string[] = [];
  const rendered = text.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_m, key: string) => {
    const v = PREVIEW_SAMPLE[key];
    if (v === undefined) { unresolved.push(key); return `{{${key}}}`; }
    return v;
  });
  return { rendered, unresolved: [...new Set(unresolved)] };
}
