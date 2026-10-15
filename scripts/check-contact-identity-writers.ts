#!/usr/bin/env npx tsx
/**
 * BT-07 static ownership gate. Contact identity evidence is transactional; a
 * future direct writer must be reviewed here rather than silently bypassing it.
 */
import fs from "fs";
import path from "path";

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const failures: string[] = [];
function walk(directory: string): string[] {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "tests" ? [] : walk(relative);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [relative] : [];
  });
}

// These are the only maintained production sinks allowed to create or mutate
// raw contact email/phone. Every one must call an observation adapter in the
// same transactional path. Tests are intentionally excluded: they are fixtures,
// not production identity writers.
const APPROVED_IDENTITY_SINKS: Record<string, RegExp> = {
  "server/services/contact-writer.ts": /recordContactIdentityObservations\(/,
  "server/storage/contacts.ts": /recordContactIdentityObservations\(/,
  "server/routes/imports.ts": /recordContactIdentityObservations(?:ForContacts)?\(/,
  "server/services/public-form-submission.ts": /recordContactIdentityObservations\(/,
  "server/services/ghl-sync.ts": /recordContactIdentityObservations\(/,
  "server/scripts/import-leads.ts": /recordContactIdentityObservationsForPgContacts\(/,
  "server/scripts/import-100k-leads.ts": /recordContactIdentityObservationsForPgContacts\(/,
  "server/services/master-leads/pipeline-promotion.ts": /recordContactIdentityObservations\(/,
};
function hasIdentityWriter(source: string, file = ""): boolean {
  // C2's CAS-fenced blank-to-NULL cleanup neither creates an address nor
  // changes provenance. Exempt only its exact guarded representation repair,
  // not the file or its other present/future email/phone writes.
  if (file === "server/services/contact-lifecycle-command.ts" &&
      source.includes('principal.role!=="admin"') &&
      source.includes('row.email!==selected.expectedEmail') &&
      source.includes('row.email.trim()!==""') &&
      source.includes('contactLifecycleIdentityFingerprint(row)!==selected.expectedIdentityFingerprint')) {
    source = source.replace(
      '...(operation==="normalize_blank_email"?{email:null}:',
      '...(operation==="normalize_blank_email"?{normalizedBlankRepresentation:null}:',
    );
  }
  if (/\.insert\(contacts\)|\bINSERT\s+INTO\s+contacts\b/i.test(source)) return true;
  if (/\bUPDATE\s+contacts\s+SET[\s\S]{0,300}?\b(?:email|phone)\s*=/i.test(source)) return true;
  return /\.update\(contacts\)[\s\S]{0,500}?\.set\(\{[^}]*\b(?:email|phone)\s*:/m.test(source);
}
const representationFixture = [
  'principal.role!=="admin"', 'row.email!==selected.expectedEmail',
  'row.email.trim()!==""',
  'contactLifecycleIdentityFingerprint(row)!==selected.expectedIdentityFingerprint',
  '.update(contacts).set({...(operation==="normalize_blank_email"?{email:null}:{archivedAt:null})})',
].join("\n");
const representationFile = "server/services/contact-lifecycle-command.ts";
for (const [label, source, file, expected] of [
  ["guarded blank representation", representationFixture, representationFile, false],
  ["other file", representationFixture, "server/other.ts", true],
  ["missing admin fence", representationFixture.replace('principal.role!=="admin"', ""), representationFile, true],
  ["nonempty email", representationFixture.replace("{email:null}", "{email:value}"), representationFile, true],
  ["additional email write", representationFixture + '\n db.update(contacts).set({email:value})', representationFile, true],
  ["additional phone write", representationFixture + '\n db.update(contacts).set({phone:value})', representationFile, true],
] as const) {
  if (hasIdentityWriter(source, file) !== expected) failures.push(`representation-repair scanner regression: ${label}`);
}
for (const file of walk("server")) {
  const source = read(file);
  if (!hasIdentityWriter(source, file)) continue;
  const requiredAdapter = APPROVED_IDENTITY_SINKS[file];
  if (!requiredAdapter) {
    failures.push(`unapproved production contact identity writer: ${file}`);
  } else if (!requiredAdapter.test(source)) {
    failures.push(`approved identity writer lacks canonical observation adapter: ${file}`);
  }
}

const sourceFiles = ["server/routes/crm-operations.ts", "server/routes/imports.ts", "server/storage/contacts.ts"];
for (const file of sourceFiles) {
  const source = read(file);
  if (/\bstorage\.mergeContacts\s*\(/.test(source)) failures.push(`${file} still invokes legacy storage.mergeContacts`);
}

// BT-08: provider-first and compatibility roots must not return. The command
// itself is the only generic creation boundary; callers must supply a source
// contract rather than recreate raw contact writes.
for (const file of walk("server")) {
  const source = read(file);
  if (/\bghl_upsert_first\b/.test(source)) failures.push(`provider-first contact mode remains in ${file}`);
  if (file !== "server/services/contact-writer.ts" && /\b(?:create|update)ContactGhlFirst\s*\(/.test(source)) {
    failures.push(`legacy GHL-first contact adapter remains in ${file}`);
  }
}
if (failures.length) {
  console.error("Contact identity writer gate failed:");
  failures.forEach((failure) => console.error(`  - ${failure}`));
  process.exit(1);
}
console.log("✓ Contact writers are observed, local-first, and legacy roots are absent");