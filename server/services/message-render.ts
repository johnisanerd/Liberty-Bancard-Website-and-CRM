/**
 * Deterministic outbound message renderer shared by campaigns and sequences.
 *
 * Pure: no database, clock, environment or network access. Given the same
 * template and context it always returns the same output, so the exact copy a
 * reviewer previews is the copy a worker sends.
 *
 *  - Token names resolve case/shape-insensitively (`{{firstName}}`,
 *    `{{first_name}}`, `{{contact.firstName}}` are one token).
 *  - Values are inserted through function replacers, so `$&`, `$1` and other
 *    replacement patterns in business names are literal text.
 *  - Values are escaped for the target format (html / text / subject).
 *  - A person greeting is used only when the contact has a genuine supported
 *    person name; role mailboxes, company-like names and missing names render
 *    "Hello,".
 *  - Anything unresolved ({{token}}, [BRACKET], %TOKEN%, empty required value)
 *    throws RenderError. It never ships as copy and never degrades silently.
 */

export type RenderFormat = "html" | "text" | "subject";

export class RenderError extends Error {
  constructor(public readonly code: string, public readonly detail: string[]) {
    super(`${code}: ${detail.join(", ")}`);
    this.name = "RenderError";
  }
}

export interface RenderContext {
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string | null;
  email?: string | null;
  agentName?: string | null;
  agentEmail?: string | null;
  agentPhone?: string | null;
  industry?: string | null;
  /** Additional trusted values (e.g. calendarLink). Keys are normalized like tokens. */
  extra?: Record<string, string | null | undefined>;
}

export interface RenderOptions {
  format: RenderFormat;
  /** Tokens that must resolve to a non-empty value. */
  required?: string[];
}

export interface RenderResult {
  output: string;
  usedTokens: string[];
  greeting: "person" | "generic" | "none";
}

const ROLE_LOCAL_PARTS = new Set([
  "info", "contact", "sales", "admin", "office", "hello", "support", "service", "services",
  "billing", "accounts", "accounting", "frontdesk", "reception", "appointments", "booking",
  "bookings", "team", "mail", "enquiries", "inquiries", "orders", "customerservice", "manager",
  "owner", "help", "staff", "hr", "marketing", "noreply", "no-reply",
]);

const COMPANY_NAME_WORDS = /\b(inc|llc|ltd|corp|co|company|group|auto|glass|contact|team|office|sales|support|info|admin|service|services|shop|studio|salon|spa|clinic|center|centre|gym|fitness|plumbing|roofing|electric|hvac|dental|medical)\b/i;

export function normalizeTokenName(raw: string): string {
  const trimmed = raw.trim().replace(/^contact\./i, "");
  const camel = trimmed.replace(/[_\-\s]+([a-zA-Z0-9])/g, (_m, c: string) => c.toUpperCase());
  return camel.charAt(0).toLowerCase() + camel.slice(1);
}

export function isRoleMailbox(email: string | null | undefined): boolean {
  if (!email) return false;
  const local = email.split("@")[0]?.toLowerCase().replace(/[^a-z0-9\-]/g, "") ?? "";
  return ROLE_LOCAL_PARTS.has(local);
}

/** True only when `firstName` looks like a real person's first name for this contact. */
export function hasSupportedPersonName(ctx: Pick<RenderContext, "firstName" | "companyName" | "email">): boolean {
  const name = (ctx.firstName ?? "").trim();
  if (!name || name.length < 2 || name.length > 30) return false;
  if (isRoleMailbox(ctx.email)) return false;
  if (/[@\d\/\\:_]|https?|www\./i.test(name)) return false;
  if (/^(n\/a|na|unknown|none|null|test|firstname|name|there|owner|manager|customer|sir|madam)$/i.test(name)) return false;
  if (name.split(/\s+/).length > 2) return false;
  if (COMPANY_NAME_WORDS.test(name)) return false;
  const company = (ctx.companyName ?? "").trim().toLowerCase();
  if (company && (company === name.toLowerCase() || company.startsWith(`${name.toLowerCase()} `) && name.split(/\s+/).length > 1)) return false;
  return /^[\p{L}][\p{L}'’.\-]*(\s[\p{L}][\p{L}'’.\-]*)?$/u.test(name);
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

const GREETING_RE = /(^|\n|<(?:p|div|td|li|h[1-6])\b[^>]*>)([ \t]*)(Hi|Hello|Hey|Dear)[ \t]+\{\{\s*(?:contact\.)?(?:first_?name)\s*\}\}[ \t]*,/gi;
const TOKEN_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;
const BRACKET_RE = /\[(?:[A-Z][A-Z0-9 _\-]{2,}|(?:first|last|company|business|your)[ _-]?name[^\]]*|insert[^\]]*|link[^\]]*|url[^\]]*)\]|%[A-Z_]{3,}%|\{[A-Za-z_]+\}/gi;

function escapeFor(value: string, format: RenderFormat): string {
  return format === "html" ? escapeHtml(value) : value.replace(/[\r\n]+/g, format === "subject" ? " " : "\n");
}

export function renderTemplate(template: string, ctx: RenderContext, opts: RenderOptions): RenderResult {
  const values = new Map<string, string>();
  const put = (key: string, value: string | null | undefined) => {
    const v = (value ?? "").toString().trim();
    values.set(normalizeTokenName(key), v);
  };
  put("companyName", ctx.companyName); put("businessName", ctx.companyName);
  put("lastName", ctx.lastName); put("email", ctx.email);
  put("agentName", ctx.agentName); put("agentEmail", ctx.agentEmail); put("agentPhone", ctx.agentPhone);
  put("industry", ctx.industry); put("vertical", ctx.industry); put("serviceType", ctx.industry);
  for (const [k, v] of Object.entries(ctx.extra ?? {})) put(k, v);

  const personName = hasSupportedPersonName(ctx);
  let greeting: RenderResult["greeting"] = "none";
  const used = new Set<string>();

  let working = template.replace(GREETING_RE, (_m, lead: string, indent: string, salutation: string) => {
    if (personName) {
      greeting = "person";
      used.add("firstName");
      return `${lead}${indent}${salutation} ${escapeFor((ctx.firstName ?? "").trim(), opts.format)},`;
    }
    greeting = "generic";
    return `${lead}${indent}Hello,`;
  });

  const unresolved: string[] = [];
  working = working.replace(TOKEN_RE, (_m, raw: string) => {
    const key = normalizeTokenName(raw);
    if (key === "firstName") {
      // Mid-body use of the first name must also never address a non-person.
      used.add(key);
      return personName ? escapeFor((ctx.firstName ?? "").trim(), opts.format) : "there";
    }
    if (!values.has(key)) { unresolved.push(`{{${raw.trim()}}}`); return ""; }
    used.add(key);
    return escapeFor(values.get(key)!, opts.format);
  });
  if (unresolved.length) throw new RenderError("RENDER_UNRESOLVED_TOKEN", [...new Set(unresolved)]);

  for (const key of opts.required ?? []) {
    const n = normalizeTokenName(key);
    if (n === "firstName") continue;
    if (!(values.get(n) ?? "").length) throw new RenderError("RENDER_REQUIRED_VALUE_EMPTY", [n]);
  }
  const leftovers = working.match(BRACKET_RE);
  if (leftovers) throw new RenderError("RENDER_BRACKET_PLACEHOLDER", [...new Set(leftovers)]);
  if (/\b(undefined|NaN|\[object Object\])\b/.test(working)) throw new RenderError("RENDER_LITERAL_UNDEFINED", ["undefined/NaN/[object Object]"]);
  return { output: working, usedTokens: [...used].sort(), greeting };
}

/** Plain-text SFP copy -> email HTML: escape done by renderTemplate(format "html"), then paragraphs + links. */
export function plainHtmlToEmailHtml(escapedBody: string, allowedHosts: string[]): string {
  const withLinks = escapedBody.replace(/https:\/\/[^\s<]+/g, (url) => {
    const clean = url.replace(/[.,;)]+$/, "");
    const tail = url.slice(clean.length);
    const decoded = clean.replace(/&amp;/g, "&");
    let host = "";
    try { host = new URL(decoded).host; } catch { throw new RenderError("RENDER_URL_INVALID", [clean]); }
    if (!allowedHosts.includes(host)) throw new RenderError("RENDER_URL_HOST_NOT_ALLOWED", [host]);
    return `<a href="${clean}">${clean}</a>${tail}`;
  });
  if (/http:\/\//i.test(withLinks)) throw new RenderError("RENDER_URL_NOT_HTTPS", ["http://"]);
  return withLinks.split(/\n{2,}/).map(p => `<p style="margin:0 0 14px 0;">${p.replace(/\n/g, "<br/>")}</p>`).join("\n");
}

/** Plain-text variant of a rendered (format "text") body. */
export function renderPlainText(template: string, ctx: RenderContext, opts?: Omit<RenderOptions, "format">): RenderResult {
  return renderTemplate(template, ctx, { ...opts, format: "text" });
}
