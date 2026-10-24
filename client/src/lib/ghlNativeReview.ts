export interface GhlReviewOperation {
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  fields: string[];
  tags: string[];
  stageIds: string[];
  safetyEvidence: string;
  purpose: string;
  customFieldIds: string[];
}

export interface GhlReviewOperationResult {
  operations: GhlReviewOperation[] | null;
  error: string | null;
}

const ALLOWED_METHOD_PATHS = new Set([
  "POST /contacts",
  "PUT /contacts/:contactId",
  "PATCH /contacts/:contactId",
  "DELETE /contacts/:contactId",
  "POST /contacts/:contactId/tags",
  "DELETE /contacts/:contactId/tags",
  "POST /opportunities",
  "PUT /opportunities/:opportunityId",
  "PATCH /opportunities/:opportunityId",
  "DELETE /opportunities/:opportunityId",
  "POST /tasks",
  "PUT /tasks/:taskId",
  "PATCH /tasks/:taskId",
  "DELETE /tasks/:taskId",
  "POST /notes",
  "PUT /notes/:noteId",
  "PATCH /notes/:noteId",
  "DELETE /notes/:noteId",
  "POST /tags",
  "PUT /tags/:tagId",
  "PATCH /tags/:tagId",
  "DELETE /tags/:tagId",
  "POST /appointments",
  "PUT /appointments/:appointmentId",
  "PATCH /appointments/:appointmentId",
  "DELETE /appointments/:appointmentId",
]);

const GENERIC_ALLOWLIST_VALUES = new Set([
  "*", "all", "all_fields", "all_tags", "all_stages", "all_custom_fields",
]);
const FIELD_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

function isStringArray(value: unknown, maxLength: number): value is string[] {
  return Array.isArray(value) && value.length <= maxLength
    && value.every((item) => typeof item === "string" && item.trim().length > 0
      && item.length <= 300 && !GENERIC_ALLOWLIST_VALUES.has(item.trim().toLowerCase()));
}

export function parseGhlReviewOperations(text: string, knownCustomFieldIds: ReadonlySet<string>): GhlReviewOperationResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { operations: null, error: "Allowed operations must be valid JSON." };
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) {
    return { operations: null, error: "Provide between 1 and 50 explicit allowed-operation entries; broad or empty allowlists are not accepted." };
  }

  const operations: GhlReviewOperation[] = [];
  for (const [index, operation] of value.entries()) {
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
      return { operations: null, error: `Operation ${index + 1} must be a JSON object.` };
    }
    const row = operation as Record<string, unknown>;
    const method = row.method;
    const path = row.path;
    if (typeof method !== "string" || typeof path !== "string" || !ALLOWED_METHOD_PATHS.has(`${method} ${path}`)) {
      return { operations: null, error: `Operation ${index + 1} must use a supported explicit CRM endpoint template and method.` };
    }
    if (!Array.isArray(row.fields) || row.fields.length < 1 || row.fields.length > 40
      || !row.fields.every((field) => typeof field === "string"
        && FIELD_NAME_PATTERN.test(field) && !GENERIC_ALLOWLIST_VALUES.has(field.toLowerCase()))) {
      return { operations: null, error: `Operation ${index + 1} requires explicit field names; wildcards and all-fields entries are not allowed.` };
    }
    if (!isStringArray(row.tags, 100) || !isStringArray(row.stageIds, 100)
      || !isStringArray(row.customFieldIds, 100)) {
      return { operations: null, error: `Operation ${index + 1} tags, stage IDs, and custom-field IDs must be explicit bounded lists.` };
    }
    if (row.customFieldIds.some((id) => !knownCustomFieldIds.has(id))) {
      return { operations: null, error: `Operation ${index + 1} refers to a custom-field ID that is not in the current server inventory.` };
    }
    if (row.customFieldIds.length > 0 && !row.fields.includes("customFields")) {
      return { operations: null, error: `Operation ${index + 1} must explicitly include the customFields body field when allowing custom-field IDs.` };
    }
    if (typeof row.safetyEvidence !== "string" || row.safetyEvidence.trim().length < 8 || row.safetyEvidence.trim().length > 500
      || typeof row.purpose !== "string" || row.purpose.trim().length < 8 || row.purpose.trim().length > 300) {
      return { operations: null, error: `Operation ${index + 1} needs a specific purpose and safety evidence (8–300/500 characters).` };
    }
    const keys = Object.keys(row).sort();
    const expectedKeys = ["customFieldIds", "fields", "method", "path", "purpose", "safetyEvidence", "stageIds", "tags"].sort();
    if (keys.length !== expectedKeys.length || keys.some((key, keyIndex) => key !== expectedKeys[keyIndex])) {
      return { operations: null, error: `Operation ${index + 1} contains unsupported or missing fields.` };
    }
    operations.push({
      method: method as GhlReviewOperation["method"],
      path,
      fields: row.fields as string[],
      tags: row.tags,
      stageIds: row.stageIds,
      safetyEvidence: row.safetyEvidence.trim(),
      purpose: row.purpose.trim(),
      customFieldIds: row.customFieldIds,
    });
  }
  return { operations, error: null };
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}
