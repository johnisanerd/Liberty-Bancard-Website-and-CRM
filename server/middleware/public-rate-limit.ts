import rateLimit from "express-rate-limit";

export const webhookRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Too many webhook requests from this IP. Please slow down.",
  },
});

export const verifyEmailRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Too many verification attempts from this IP. Please wait a few minutes and try again.",
  },
});

export const publicLeadRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Too many submissions from this IP. Please wait a few minutes and try again.",
  },
  // Allow loopback requests to bypass the limiter outside production so the
  // form integration smoke test (scripts/test-forms.ts) can submit forms
  // repeatedly without tripping a 429. Production traffic is unaffected.
  skip: (req) => {
    if (process.env.NODE_ENV === "production") return false;
    const ip = req.ip ?? "";
    return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  },
});

export const merchantAuthRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Too many login attempts from this IP. Please wait a few minutes and try again.",
  },
  // Allow loopback requests to bypass the limiter outside production so the
  // role-guard smoke test (scripts/smoke-role-guards.ts) can authenticate
  // repeatedly without tripping a 429. Production traffic is unaffected.
  skip: (req) => {
    if (process.env.NODE_ENV === "production") return false;
    const ip = req.ip ?? "";
    return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  },
});

/**
 * Visitor messages inside an already-open live chat session. Higher ceiling than
 * the lead limiter because a real conversation sends many short messages, but
 * still bounded so one IP cannot flood the agent inbox or notifications.
 */
export const publicChatMessageRateLimit = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "You are sending messages too quickly. Please wait a moment and try again.",
  },
  skip: (req) => {
    if (process.env.NODE_ENV === "production") return false;
    const ip = req.ip ?? "";
    return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  },
});
