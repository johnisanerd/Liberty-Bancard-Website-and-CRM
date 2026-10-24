/**
 * Presentation facts for a final commercial email, measured on the HTML that is actually handed to a transport.
 * The Liberty signature owner (email-signatures.ts) marks its block, so "one signature" is a count, not a guess.
 * Nothing here adds a signature or a CTA: a message keeps the signature its sending family chose.
 */
const SIGNATURE_BLOCK_RE = /<div\b[^>]*\bdata-liberty-signature\b[^>]*>[\s\S]*?<\/div>/gi;
const FOOTER_RE = /<div\b[^>]*\bdata-can-spam-footer\b[^>]*>/gi;
const LEGACY_SIGNATURE_RE = /1-?\(?\d{3}\)?[-\s.]\d{3}[-\s.]\d{4}|954-266-8214/;

export interface PresentationFacts {
  logoCount: number;
  signatureCount: number;
  footerCount: number;
  signatureKind: "marked" | "unmarked" | "none";
}

export function inspectPresentation(html: string): PresentationFacts {
  const marked = (html.match(SIGNATURE_BLOCK_RE) ?? []).length;
  const logos = (html.match(/<img\b[^>]*(?:logo|alt\s*=\s*"Liberty Bancard")[^>]*>/gi) ?? []).length;
  const unmarked = marked === 0 && LEGACY_SIGNATURE_RE.test(html.replace(/<[^>]+>/g, " "));
  return {
    logoCount: logos,
    signatureCount: marked || (unmarked ? 1 : 0),
    footerCount: (html.match(FOOTER_RE) ?? []).length,
    signatureKind: marked ? "marked" : unmarked ? "unmarked" : "none",
  };
}

/** Keeps the first marked Liberty signature and drops any repeat (and the logo inside it). */
export function collapseDuplicateSignatures(html: string): string {
  let seen = 0;
  return html.replace(SIGNATURE_BLOCK_RE, (block) => (++seen === 1 ? block : ""));
}
