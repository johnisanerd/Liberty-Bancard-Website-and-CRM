/**
 * Wording checks shared by the retained-copy audit script and the publish routes for templates and workflow steps.
 * Pure functions only (token support and rendering come from the shared registry): no database, network or environment.
 */

import { renderPersonas, tokensIn, unsupportedTokens, type MessagePurpose } from "./message-token-registry";

export const COPY_RULES: Array<{ id: string; test: RegExp; why: string }> = [
  { id: "bracket_placeholder", test: /\[[A-Z][A-Z0-9_]{3,}\]/g, why: "Unresolved bracket placeholder would be sent literally" },
  { id: "dead_link", test: /href=["']#["']/gi, why: "Link has no destination" },
  { id: "attachment_ask", test: /(reply|respond)[^.]{0,60}attach|attach[^.]{0,60}(voided check|driver'?s? licen[sc]e|photo id|identification)|email[^.]{0,40}(voided check|photo id|driver'?s? licen[sc]e)/gi, why: "Asks the recipient to email sensitive documents; use the secure upload journey" },
  { id: "unsupported_timing", test: /within\s+(1|one)\s+business\s+day|in\s+(just\s+)?5\s+minutes|same[- ]day|guaranteed/gi, why: "Timing or guarantee not backed by a recorded policy" },
  { id: "unsupported_proof", test: /\b(thousands of merchants|trusted by \d|saved (our|my) clients|average (savings|saving) of)\b/gi, why: "Social-proof or savings claim without a stored source" },
  { id: "exists_claim", test: /(your (statement |processing |savings )?analysis (is|has been|was) (saved|on file|stored)|the numbers (haven'?t|have not) changed|your application (is|has been) approved|agreement (is|was) sent)/gi, why: "States a record exists without a recorded event" },
];

export interface CopyFinding { rule: string; match: string; why: string }

export function mergeVariables(text: string): string[] {
  return tokensIn(text);
}

/**
 * Publication-time checks for one purpose. Token support and render behavior come from the shared registry and the
 * deterministic renderer, so anything that passes here renders the same way in the preview and at dispatch.
 */
export function lintRules(text: string): CopyFinding[] {
  const out: CopyFinding[] = [];
  for (const rule of COPY_RULES) {
    const hits = [...text.matchAll(new RegExp(rule.test.source, rule.test.flags))].map((m) => m[0].slice(0, 80));
    for (const hit of new Set(hits)) out.push({ rule: rule.id, match: hit, why: rule.why });
  }
  return out;
}

export function lintCopy(text: string, purpose: MessagePurpose): CopyFinding[] {
  const out: CopyFinding[] = lintRules(text);
  for (const token of unsupportedTokens(purpose, text)) {
    out.push({ rule: "unknown_merge_variable", match: token, why: `Token is not available for ${purpose === "workflow" ? "workflow steps" : "stored templates"}; it would not be filled when sent` });
  }
  if (!out.some((f) => f.rule === "unknown_merge_variable")) {
    // Render with every sample persona through the real renderer. A deal-dependent token is fine here because the
    // sample persona includes a deal; unresolved, bracket and literal-undefined output are still caught.
    for (const persona of renderPersonas(purpose, { body: text }, "text")) {
      if (!persona.error) continue;
      if (persona.error.code === "RENDER_BRACKET_PLACEHOLDER" && out.some((f) => f.rule === "bracket_placeholder")) continue;
      const match = persona.error.detail.join(", ").slice(0, 80);
      if (!out.some((f) => f.rule === `render_${persona.error!.code}` && f.match === match)) {
        out.push({ rule: `render_${persona.error.code}`, match, why: "The real message renderer rejects this text" });
      }
    }
  }
  return out;
}
