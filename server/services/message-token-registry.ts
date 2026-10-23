/**
 * Purpose-specific merge-token registry and the single rendering path shared by publication checks, previews and
 * dispatch for workflow steps and stored message templates.
 *
 * Pure: no database, clock, environment or network access.
 *
 * A token is "supported" for a purpose only when `buildRenderContext` for that purpose can supply it. The same builder
 * feeds the preview (with sample data) and the sender (with the real contact/deal), so the two cannot disagree about
 * which tokens exist. Rendering goes through the deterministic renderer in message-render.ts: values are escaped for
 * their output format, unresolved tokens throw, and a person greeting is used only for a genuine person name.
 */
import { RenderError, normalizeTokenName, renderTemplate, type RenderContext, type RenderFormat } from "./message-render";

export type MessagePurpose = "workflow" | "template";

const CONTACT_TOKENS = ["firstName", "lastName", "fullName", "companyName", "businessName", "email", "phone", "vertical", "calendarLink"] as const;
const WORKFLOW_DEAL_TOKENS = ["stage", "offerPath", "effectiveRate", "totalVolume"] as const;
const TEMPLATE_DEAL_TOKENS = [
  ...WORKFLOW_DEAL_TOKENS, "totalFees", "avgTicket", "recommendedPath", "terminalRecommendation",
  "estimatedGrossProfitMonthly", "merchantTier",
] as const;

/** Normalized token names (see normalizeTokenName) each purpose can resolve. */
export const TOKEN_REGISTRY: Record<MessagePurpose, readonly string[]> = {
  workflow: [...CONTACT_TOKENS, ...WORKFLOW_DEAL_TOKENS.map((k) => `deal.${k}`)],
  template: [...CONTACT_TOKENS, ...TEMPLATE_DEAL_TOKENS.map((k) => `deal.${k}`)],
};

export interface TokenSource {
  contact: {
    firstName?: string | null; lastName?: string | null; email?: string | null; phone?: string | null;
    companyName?: string | null; vertical?: string | null;
  };
  /** Absent when the run has no deal: deal tokens then fail to resolve instead of printing blanks. */
  deal?: Partial<Record<(typeof TEMPLATE_DEAL_TOKENS)[number], string | null | undefined>> | null;
  calendarLink?: string | null;
  /** Send-time values supplied by a trusted caller; never available to publication checks. */
  extra?: Record<string, string | null | undefined>;
}

export function isSupportedToken(purpose: MessagePurpose, rawToken: string): boolean {
  return TOKEN_REGISTRY[purpose].includes(normalizeTokenName(rawToken));
}

export function buildRenderContext(purpose: MessagePurpose, source: TokenSource): RenderContext {
  const c = source.contact;
  const fullName = [c.firstName, c.lastName].map((v) => (v ?? "").trim()).filter(Boolean).join(" ");
  const extra: Record<string, string | null | undefined> = { phone: c.phone, fullName };
  // A missing calendar link must fail rendering rather than ship an empty href.
  if (source.calendarLink) extra.calendarLink = source.calendarLink;
  if (source.deal) {
    for (const key of TOKEN_REGISTRY[purpose]) {
      if (!key.startsWith("deal.")) continue;
      const field = key.slice("deal.".length) as keyof NonNullable<TokenSource["deal"]>;
      extra[key] = (source.deal[field] ?? "") as string;
    }
  }
  for (const [k, v] of Object.entries(source.extra ?? {})) extra[k] = v;
  return {
    firstName: c.firstName, lastName: c.lastName, companyName: c.companyName, email: c.email,
    industry: c.vertical, extra,
  };
}

export function renderMessage(purpose: MessagePurpose, text: string, source: TokenSource, format: RenderFormat) {
  // Reject unsupported names up front so the error names the token rather than a generic unresolved value.
  const unsupported = unsupportedTokens(purpose, text, Object.keys(source.extra ?? {}));
  if (unsupported.length) throw new RenderError("RENDER_UNSUPPORTED_TOKEN", unsupported);
  return renderTemplate(text, buildRenderContext(purpose, source), { format });
}

export function tokensIn(text: string): string[] {
  return [...new Set([...text.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map((m) => m[1].trim()))];
}

export function unsupportedTokens(purpose: MessagePurpose, text: string, sendTimeKeys: string[] = []): string[] {
  const extra = new Set(sendTimeKeys.map(normalizeTokenName));
  return tokensIn(text)
    .filter((t) => !isSupportedToken(purpose, t) && !extra.has(normalizeTokenName(t)))
    .map((t) => `{{${t}}}`);
}

export const PREVIEW_PERSONAS: Array<{ id: "named" | "role_address" | "missing_name"; label: string; source: TokenSource }> = (() => {
  const deal = {
    stage: "Proposal", offerPath: "Standard", effectiveRate: "3.1%", totalVolume: "$48,000", totalFees: "$1,490",
    avgTicket: "$42", recommendedPath: "Interchange plus", terminalRecommendation: "Countertop terminal",
    estimatedGrossProfitMonthly: "$210", merchantTier: "Tier 2",
  };
  const base = {
    lastName: "Sample", phone: "(555) 010-0100", companyName: "Sample Business LLC", vertical: "restaurant",
  };
  return [
    { id: "named" as const, label: "Named contact", source: { contact: { ...base, firstName: "Alex", email: "alex@sample-business.example" }, deal, calendarLink: "https://example.test/book" } },
    { id: "role_address" as const, label: "Role mailbox", source: { contact: { ...base, firstName: "Info", email: "info@sample-business.example" }, deal, calendarLink: "https://example.test/book" } },
    { id: "missing_name" as const, label: "Missing name", source: { contact: { ...base, firstName: "", lastName: "", email: "orders@sample-business.example" }, deal, calendarLink: "https://example.test/book" } },
  ];
})();

export interface PersonaRender {
  persona: string;
  label: string;
  subject?: string;
  body: string;
  greeting: string;
  error: { code: string; detail: string[] } | null;
}

/** Renders with each persona through the real renderer. `kind` selects html (email body) or text (SMS) output. */
export function renderPersonas(
  purpose: MessagePurpose,
  input: { subject?: string | null; body: string },
  kind: "html" | "text",
): PersonaRender[] {
  return PREVIEW_PERSONAS.map(({ id, label, source }) => {
    try {
      const subject = input.subject ? renderMessage(purpose, input.subject, source, "subject").output : undefined;
      const body = renderMessage(purpose, input.body, source, kind);
      return { persona: id, label, subject, body: body.output, greeting: body.greeting, error: null };
    } catch (err) {
      if (err instanceof RenderError) {
        // Show the rest of the message with each offending token marked, so the reviewer sees where it sits.
        const mark = (text: string) => text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (m, raw: string) =>
          isSupportedToken(purpose, raw) ? m : `«${raw.trim()}»`);
        let subject: string | undefined;
        let body = "";
        let greeting = "none";
        try {
          subject = input.subject ? renderMessage(purpose, mark(input.subject), source, "subject").output : undefined;
          const r = renderMessage(purpose, mark(input.body), source, kind);
          body = r.output; greeting = r.greeting;
        } catch { /* leave partial output empty when even the marked text cannot render */ }
        return { persona: id, label, subject, body, greeting, error: { code: err.code, detail: err.detail } };
      }
      throw err;
    }
  });
}

/** Preview payload built from the same renderer as dispatch. The named persona is the headline rendering. */
export function previewMessage(purpose: MessagePurpose, input: { subject?: string | null; body: string }, kind: "html" | "text") {
  const personas = renderPersonas(purpose, input, kind);
  const headline = personas[0];
  const unresolved = [...new Set([
    ...unsupportedTokens(purpose, `${input.subject ?? ""}\n${input.body}`),
    ...personas.flatMap((p) => (p.error?.code === "RENDER_UNRESOLVED_TOKEN" ? p.error.detail : [])),
  ])];
  return {
    subject: headline.subject ?? "",
    body: headline.body,
    unresolved,
    renderError: personas.find((p) => p.error)?.error ?? null,
    personas,
  };
}
