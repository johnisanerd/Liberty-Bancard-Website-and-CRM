/**
 * Shared claim step for public routes that are registered outside the public.ts middleware (partner application,
 * privacy request, co-branded lead form). Same rules as every other public intake: a UUIDv4 Idempotency-Key is required,
 * the occurrence is claimed before any business write, and a replay returns the stored receipt.
 */
import type { Request, Response } from "express";
import { claimInboundRequest, type InboundClaimResult } from "./inbound-request-authority";

export function publicInboundCallerScope(req: { ip?: string }): string {
  return `public:${req.ip || "unknown"}`;
}

/**
 * Returns the claimed request, or null after writing the response (missing key, conflict, replay, rejection).
 * `payload` must exclude secrets: only its hash is stored, but a password hash-input is still a guessable oracle.
 */
export async function claimPublicInbound(
  req: Request,
  res: Response,
  source: readonly [string, string],
  payload: unknown,
  options?: {
    /** Runs on a replay of an unfinished occurrence to complete its missing local work. */
    onReplay?: (request: Extract<InboundClaimResult, { outcome: "replay" }>["request"]) => Promise<{ failed?: string; state?: string }>;
  },
): Promise<Extract<InboundClaimResult, { outcome: "claimed" }>["request"] | null> {
  const key = req.header("Idempotency-Key");
  if (!key) {
    res.status(400).json({ error: "MISSING_IDEMPOTENCY_KEY" });
    return null;
  }
  res.setHeader("Idempotency-Key", key);
  try {
    const claim = await claimInboundRequest({
      idempotencyKey: key,
      sourceCategory: source[0],
      sourceType: source[1],
      callerScope: publicInboundCallerScope(req),
      actorType: "public",
      payload,
    });
    if (claim.outcome === "conflict") { res.status(409).json({ error: "Idempotency key conflicts with another request" }); return null; }
    if (claim.outcome === "scope_mismatch") { res.status(404).json({ error: "Request not found" }); return null; }
    if (claim.outcome === "replay") {
      // A retry of an attempt that failed or was cancelled must not look like success: nothing was recorded for it.
      const state = claim.request.lifecycleState;
      if (state === "failed" || state === "cancelled") {
        res.status(409).json({ success: false, replayed: true, error: "PREVIOUS_ATTEMPT_NOT_RECORDED", requestReceipt: claim.request.id, status: state });
        return null;
      }
      let status: string = claim.request.lifecycleState;
      if (options?.onReplay) {
        const resumed = await options.onReplay(claim.request);
        if (resumed.failed) {
          res.status(409).json({ success: false, replayed: true, error: "PREVIOUS_ATTEMPT_NOT_RECORDED", requestReceipt: claim.request.id, status: "failed" });
          return null;
        }
        if (resumed.state) status = resumed.state;
      }
      res.status(200).json({ success: true, replayed: true, requestReceipt: claim.request.id, status });
      return null;
    }
    return claim.request;
  } catch (error) {
    const code = error instanceof Error ? error.message.split(":")[0] : "INBOUND_REQUEST_REJECTED";
    res.status(code === "INVALID_INBOUND_IDEMPOTENCY_KEY" ? 400 : 503).json({ error: code });
    return null;
  }
}
