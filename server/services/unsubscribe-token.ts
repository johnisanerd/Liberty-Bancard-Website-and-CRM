import crypto from "crypto";

const HMAC_HEX_RE = /^[a-f0-9]{64}$/;
const OCCURRENCE_RE = /^[a-f0-9-]{36}$/i;

function signUnsubscribeToken(contactId: number, occurrenceId: string, secret: string): string {
  return crypto.createHmac("sha256", secret)
    .update(`email_unsubscribe:${contactId}:${occurrenceId}`)
    .digest("hex");
}

export function getUnsubscribeTokenSecret(): string {
  const testMode = process.env.TEST_MODE === "true";

  const secret = process.env.UNSUBSCRIBE_TOKEN_SECRET || process.env.SESSION_SECRET;
  if (secret) return secret;

  if (testMode) {
    return "test-only-unsubscribe-secret-do-not-use-in-production";
  }

  throw new Error(
    "Cold email send blocked: UNSUBSCRIBE_TOKEN_SECRET (or SESSION_SECRET) must be set in production. " +
    "Set UNSUBSCRIBE_TOKEN_SECRET to a strong random string."
  );
}

export function generateUnsubscribeToken(contactId: number): string {
  const secret = getUnsubscribeTokenSecret();
  const occurrenceId = crypto.randomUUID();
  return `${contactId}.${occurrenceId}.${signUnsubscribeToken(contactId, occurrenceId, secret)}`;
}

export function verifyUnsubscribeToken(token: string): { valid: true; contactId: number; occurrenceId: string } | { valid: false } {
  try {
    if (!token || typeof token !== "string") return { valid: false };

    const segments = token.split(".");

    if (segments.length !== 2 && segments.length !== 3) return { valid: false };

    const [idPart, secondPart, thirdPart] = segments;
    const isLegacy = segments.length === 2;
    const occurrenceId = isLegacy ? crypto.randomUUID() : secondPart;
    const suppliedHmac = isLegacy ? secondPart : thirdPart;

    if (!idPart || !occurrenceId || !suppliedHmac) return { valid: false };

    if (!HMAC_HEX_RE.test(suppliedHmac)) return { valid: false };
    if (!isLegacy && !OCCURRENCE_RE.test(occurrenceId)) return { valid: false };

    const contactId = parseInt(idPart, 10);
    if (isNaN(contactId) || contactId <= 0 || String(contactId) !== idPart) {
      return { valid: false };
    }

    let secret: string;
    try {
      secret = getUnsubscribeTokenSecret();
    } catch {
      return { valid: false };
    }

    const expectedHmac = isLegacy
      ? crypto.createHmac("sha256", secret).update(`email_unsubscribe:${contactId}`).digest("hex")
      : signUnsubscribeToken(contactId, occurrenceId, secret);

    const suppliedBuf = Buffer.from(suppliedHmac, "hex");
    const expectedBuf = Buffer.from(expectedHmac, "hex");

    if (suppliedBuf.length !== expectedBuf.length) return { valid: false };

    if (!crypto.timingSafeEqual(suppliedBuf, expectedBuf)) return { valid: false };

    return { valid: true, contactId, occurrenceId };
  } catch {
    return { valid: false };
  }
}

// ── Seed-test unsubscribe tokens ─────────────────────────────────────────────
// A seed message has no contact. Its token is a different kind ("seed.<occurrence>.<hmac>", signed over a different
// string), so it can never verify as a contact token and a contact token can never verify as a seed token.
const SEED_OCCURRENCE_RE = /^[a-f0-9-]{36}$/i;

function signSeedUnsubscribeToken(occurrenceId: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(`seed_email_unsubscribe:${occurrenceId}`).digest("hex");
}

export function generateSeedUnsubscribeToken(occurrenceId: string): string {
  if (!SEED_OCCURRENCE_RE.test(occurrenceId)) throw new Error("SEED_OCCURRENCE_INVALID");
  return `seed.${occurrenceId}.${signSeedUnsubscribeToken(occurrenceId, getUnsubscribeTokenSecret())}`;
}

export function verifySeedUnsubscribeToken(token: string): { valid: true; occurrenceId: string } | { valid: false } {
  try {
    if (!token || typeof token !== "string") return { valid: false };
    const segments = token.split(".");
    if (segments.length !== 3 || segments[0] !== "seed") return { valid: false };
    const [, occurrenceId, supplied] = segments;
    if (!SEED_OCCURRENCE_RE.test(occurrenceId) || !HMAC_HEX_RE.test(supplied)) return { valid: false };
    const expected = Buffer.from(signSeedUnsubscribeToken(occurrenceId, getUnsubscribeTokenSecret()), "hex");
    const given = Buffer.from(supplied, "hex");
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return { valid: false };
    return { valid: true, occurrenceId };
  } catch {
    return { valid: false };
  }
}
