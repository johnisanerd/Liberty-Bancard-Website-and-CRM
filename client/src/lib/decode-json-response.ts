/**
 * Decode a successful fetch Response body as JSON and validate the fields a caller will
 * display. apiRequest resolves with the Response, so reading fields off it directly yields
 * undefined; this makes receipts (counts, created flags) come from the real payload and
 * turns an unexpected shape into an explicit error instead of a fabricated success.
 */
export async function decodeJsonResponse<T>(
  res: Response,
  validate: (value: unknown) => value is T,
  label: string,
): Promise<T> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error(`${label}: the server response could not be read.`);
  }
  if (!validate(body)) throw new Error(`${label}: the server response did not have the expected fields.`);
  return body;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
