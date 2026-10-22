/**
 * Metric contract for rates. A rate is only a number when its denominator is non-zero.
 * Every rate exposes numerator, denominator and availability so a UI never renders an empty
 * denominator as 0%.
 */
export interface RateMetric {
  numerator: number;
  denominator: number;
  /** Rounded whole percent, or null when the denominator is 0. */
  percent: number | null;
  available: boolean;
}

export function computeRate(numerator: number, denominator: number): RateMetric {
  const available = Number.isFinite(denominator) && denominator > 0;
  return { numerator, denominator, percent: available ? Math.round((numerator / denominator) * 100) : null, available };
}

/** Sales stages outside the open set that are neither closed outcomes nor nurture. */
export const SALES_CLOSED_WON_STAGE = "Closed Won";
export const SALES_CLOSED_LOST_STAGE = "Closed Lost";
export const SALES_NURTURE_STAGE = "Nurture / Not Now";
