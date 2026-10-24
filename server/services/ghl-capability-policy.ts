export type GhlCapability =
  | "crm_read"
  | "diagnostic_read"
  | "crm_write"
  | "permission_write"
  | "communication"
  | "unknown";

const COMMUNICATION_PATHS = [
  /^\/conversations\/messages(?:\/|$)/i,
  /^\/conversations\/providers\/[^/]+\/messages(?:\/|$)/i,
  /^\/workflows(?:\/|$)/i,
  /^\/contacts\/[^/]+\/workflow\/[^/]+(?:\/|$)/i,
  /^\/contacts\/[^/]+\/enrollments?(?:\/|$)/i,
  /^\/locations\/[^/]+\/workflows\/[^/]+\/(?:enroll|trigger)(?:\/|$)/i,
];

const DIAGNOSTIC_PATHS = [
  /^\/locations\/[^/]+$/i,
  /^\/locations\/[^/]+\/(?:email-settings|phone-numbers|customValues|customFields|tags|users|calendars)$/i,
  /^\/locations\/[^/]+\/(?:customFields|customValues)\/[A-Za-z0-9_-]{1,128}$/i,
  /^\/workflows\/?$/i,
];

const CRM_RESOURCES = new Set([
  "contacts", "opportunities", "tasks", "notes", "tags", "appointments",
  "calendars", "companies", "businesses",
]);

const PERMISSION_CUSTOM_FIELD_KEYS = new Set([
  "lb_do_not_contact", "lb_do_not_autocontact", "lb_lifecycle_stage",
  "lb_channel_permissions_updated_at", "lb_consent_tier", "lb_can_email",
  "lb_can_manual_call", "lb_can_sms", "lb_can_ai_voice", "lb_can_ringless_vm",
  "lb_channel_permissions", "lb_channel_block_reason", "lb_consent_sms", "lb_consent_email",
]);
export function isKnownPermissionCustomFieldKey(key: string): boolean {
  return PERMISSION_CUSTOM_FIELD_KEYS.has(key);
}

const PERMISSION_ROOT_KEYS = new Set([
  "permissions", "emailDnd", "smsDnd", "callDnd", "dnd", "lb_sms_allowed",
  "lb_voice_ai_allowed", "lb_ringless_vm_allowed", "lb_manual_call_allowed",
  "emailConsent", "smsConsent", "communicationPreferences",
]);

export function ghlBodyContainsPermissionWrite(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const obj = body as Record<string, any>;
  return Object.keys(obj).some(key => PERMISSION_ROOT_KEYS.has(key))
    || (Array.isArray(obj.customFields) && obj.customFields.some((field: any) =>
      field && typeof field === "object" && isKnownPermissionCustomFieldKey(String(field.key ?? ""))));
}

function isSearch(method: string, path: string): boolean {
  return method === "POST" && /^\/(?:contacts|opportunities)\/search$/i.test(path);
}

function isPermissionPayload(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const obj = body as Record<string, unknown>;
  const permissionKeys = PERMISSION_ROOT_KEYS;
  const topLevel = Object.keys(obj).filter(key => !["id", "contactId", "locationId"].includes(key));
  if (topLevel.length > 0 && topLevel.every(key => permissionKeys.has(key))) return true;
  const customFields = obj.customFields;
  return topLevel.length === 1 && topLevel[0] === "customFields"
    && Array.isArray(customFields) && customFields.length > 0
    && customFields.every((field: any) => field && typeof field === "object"
      && PERMISSION_CUSTOM_FIELD_KEYS.has(String(field.key ?? "")));
}

const WRITE_TEMPLATES: Array<{ path: RegExp; template: string; methods: string[] }> = [
  { path: /^\/contacts$/i, template: "/contacts", methods: ["POST"] },
  { path: /^\/contacts\/[A-Za-z0-9_-]{1,128}$/i, template: "/contacts/:contactId", methods: ["PUT", "PATCH", "DELETE"] },
  // Add/remove tags on one contact. Additive/subtractive by construction: cannot replace the contact's tag set.
  { path: /^\/contacts\/[A-Za-z0-9_-]{1,128}\/tags$/i, template: "/contacts/:contactId/tags", methods: ["POST", "DELETE"] },
  { path: /^\/opportunities$/i, template: "/opportunities", methods: ["POST"] },
  { path: /^\/opportunities\/[A-Za-z0-9_-]{1,128}$/i, template: "/opportunities/:opportunityId", methods: ["PUT", "PATCH", "DELETE"] },
  { path: /^\/tasks$/i, template: "/tasks", methods: ["POST"] },
  { path: /^\/tasks\/[A-Za-z0-9_-]{1,128}$/i, template: "/tasks/:taskId", methods: ["PUT", "PATCH", "DELETE"] },
  { path: /^\/notes$/i, template: "/notes", methods: ["POST"] },
  { path: /^\/notes\/[A-Za-z0-9_-]{1,128}$/i, template: "/notes/:noteId", methods: ["PUT", "PATCH", "DELETE"] },
  { path: /^\/tags$/i, template: "/tags", methods: ["POST"] },
  { path: /^\/tags\/[A-Za-z0-9_-]{1,128}$/i, template: "/tags/:tagId", methods: ["PUT", "PATCH", "DELETE"] },
  { path: /^\/appointments$/i, template: "/appointments", methods: ["POST"] },
  { path: /^\/appointments\/[A-Za-z0-9_-]{1,128}$/i, template: "/appointments/:appointmentId", methods: ["PUT", "PATCH", "DELETE"] },
];

export function resolveGhlWriteTemplate(methodInput: string, pathInput: string): string | null {
  const method = methodInput.toUpperCase();
  const path = pathInput.split("?")[0].replace(/\/+$/, "") || "/";
  return WRITE_TEMPLATES.find(candidate => candidate.methods.includes(method) && candidate.path.test(path))?.template ?? null;
}

export function isAllowedGhlWriteTemplate(methodInput: string, pathInput: string): boolean {
  return resolveGhlWriteTemplate(methodInput, pathInput) !== null;
}

export function isRegisteredGhlWriteTemplate(methodInput: string, template: string): boolean {
  return WRITE_TEMPLATES.some(candidate =>
    candidate.methods.includes(methodInput.toUpperCase()) && candidate.template === template);
}

function isExplicitCrmReadPath(path: string): boolean {
  if (/^\/(?:contacts|opportunities|tasks|notes|tags|appointments|calendars|companies|businesses)$/i.test(path)) return true;
  if (/^\/(?:contacts|opportunities|tasks|notes|tags|appointments|calendars|companies|businesses)\/[A-Za-z0-9_-]{1,128}$/i.test(path)) return true;
  if (/^\/contacts\/search\/duplicate$/i.test(path)) return true;
  return /^\/contacts\/[A-Za-z0-9_-]{1,128}\/(?:tasks|notes)$/i.test(path)
    || /^\/calendars\/[A-Za-z0-9_-]{1,128}\/free-slots$/i.test(path);
}

/** Pure, intentionally conservative provider capability classifier. */
export function classifyGhlOperation(methodInput: string, pathInput: string, body?: unknown): GhlCapability {
  const method = methodInput.toUpperCase();
  const path = pathInput.split("?")[0].replace(/\/+$/, "") || "/";
  if (method === "GET" && DIAGNOSTIC_PATHS.some(pattern => pattern.test(path))) return "diagnostic_read";
  if (COMMUNICATION_PATHS.some(pattern => pattern.test(path))) return "communication";
  const segments = path.split("/").filter(Boolean);
  const resource = segments[0]?.toLowerCase();
  const knownResource = !!resource && CRM_RESOURCES.has(resource);
  const search = isSearch(method, path);
  if (method === "GET" && (isExplicitCrmReadPath(path) || /^\/locations\/[^/]+\/(?:customFields|customValues)$/i.test(path))) return "crm_read";
  if (search) return "crm_read";
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && knownResource) {
    if (!resolveGhlWriteTemplate(method, path)) return "unknown";
    return resource === "contacts" && isPermissionPayload(body) ? "permission_write" : "crm_write";
  }
  return "unknown";
}