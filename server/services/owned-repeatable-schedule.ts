import {createHash} from "node:crypto";

type RepeatableSchedule = {
  key: string;
  name: string;
  id?: string | null;
  endDate?: number | null;
  tz?: string | null;
  pattern?: string | null;
  every?: string | number | null;
};

/**
 * BullMQ v5 returns a hashed key and omits id for modern repeatable metadata.
 * Reconstruct its exact descriptor with OUR stable jobId, not a name/prefix
 * match. This recognizes old intervals without touching another named schedule.
 * Custom keys and incomplete metadata are deliberately not inferred.
 */
export function isOwnedRepeatableSchedule(
  job: RepeatableSchedule,
  jobName: string,
  jobId: string,
  hashAlgorithm = "md5",
): boolean {
  if (job.name !== jobName) return false;
  if (job.id) return job.id === jobId;
  const suffix = job.pattern || (job.every == null ? "" : String(job.every));
  if (!suffix) return false;
  const descriptor = `${jobName}:${jobId}:${job.endDate ?? ""}:${job.tz ?? ""}:${suffix}`;
  return job.key === descriptor
    || job.key === createHash(hashAlgorithm).update(descriptor).digest("hex");
}
