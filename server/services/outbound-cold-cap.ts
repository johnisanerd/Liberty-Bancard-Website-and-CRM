/**
 * One definition of the effective daily cold-email ceiling, shared by the
 * sequence worker's atomic reservation and the operator release authority so
 * the two can never disagree. The ceiling is the configured daily cap, further
 * limited by the warm-up schedule when warm-up is enabled.
 */
import { storage } from "../storage";

export async function getEffectiveColdDailyCap(): Promise<number> {
  const capRaw = await storage.getSystemSetting("outboundDailyEmailCap");
  let cap = typeof capRaw === "number" ? capRaw : parseInt(String(capRaw ?? "200"), 10) || 200;
  const warmupEnabled = await storage.getSystemSetting("deliveryWarmupEnabled");
  if (warmupEnabled === true || warmupEnabled === "true") {
    const start = await storage.getSystemSetting("deliveryWarmupStartDate");
    if (typeof start === "string" && start) {
      const days = Math.max(1, Math.floor((Date.now() - new Date(start).getTime()) / 86400000) + 1);
      const ramp = days >= 30 ? 250 : days >= 14 ? 100 : days >= 7 ? 50 : 20;
      cap = Math.min(cap, ramp);
    }
  }
  return cap;
}
