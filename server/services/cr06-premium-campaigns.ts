import { createHash, createHmac, randomUUID } from "node:crypto";
import { pool } from "../db";
import { decideMarketingEmailValidation } from "./provider-readiness-control";
import { getPauseState } from "./outbound-pause-authority";
import { resolvePolicy, SENDER_POLICY_VERSION } from "./sender-policy";
import { renderCr06Recipient } from "./cr06-renderer";
import { getUnsubscribeTokenSecret } from "./unsubscribe-token";

export const CR06_MANIFEST_VERSION = "liberty-premium-pilots-v2";
export const CR06_RENDERER_VERSION = "cr06-renderer-v1";
export const CR06_MAX_PREPARED_MEMBERS = 250;
export const CR06_DISPATCH_AVAILABLE = false;
export const CR06_GATE_CONFIRMATION = "CR06_OPEN_EXACT_VERSION_COHORT";

type PilotKey = "premium-auto-repair-fl" | "premium-medspa-dental" | "premium-home-services";

interface ContentDefinition {
  key: string;
  touch: number;
  day: number;
  subject: string;
  paragraphs: string[];
}

interface ProgramDefinition {
  key: PilotKey;
  name: string;
  audience: string;
  hypothesis: string;
  cta: string;
  ctaUrl: string;
  sequenceKey: string;
  manualTaskKey: string;
  contents: ContentDefinition[];
}

const PROGRAMS: readonly ProgramDefinition[] = [
  {
    key: "premium-auto-repair-fl",
    name: "Premium Pilot A — Florida Auto Repair",
    audience: "Florida owner-operated auto repair businesses with one to three locations",
    hypothesis: "Card-present tickets, deposits, mobile acceptance, and equipment or deposit friction",
    cta: "10-minute statement review",
    ctaUrl: "https://libertybancard.com/free-analysis",
    sequenceKey: "premium-auto-repair-fl-sequence",
    manualTaskKey: "premium-auto-repair-fl-research-call",
    contents: [
      {
        key: "premium-auto-repair-fl-email-1", touch: 1, day: 1,
        subject: "A second look at your shop's payment flow",
        paragraphs: [
          "Repair shops often collect a mix of card-present payments, deposits, and payments away from the counter. That mix can make equipment and deposit timing worth reviewing, even when the current setup is working.",
          "Liberty Bancard can review one current processing statement and compare the payment flow with the way your shop operates. The review is practical and does not require a processor change.",
        ],
      },
      {
        key: "premium-auto-repair-fl-email-2", touch: 2, day: 4,
        subject: "Deposits and mobile payments at the shop",
        paragraphs: [
          "Following up because repair work does not always begin and end at a fixed checkout counter. Deposits, larger tickets, and mobile acceptance can create different workflow needs across the same shop.",
          "If you share one recent statement, we can give it a second set of eyes and identify questions worth asking about equipment, funding, and acceptance options. We will keep the review focused on your current facts.",
        ],
      },
      {
        key: "premium-auto-repair-fl-email-3", touch: 3, day: 8,
        subject: "One statement, focused payment review",
        paragraphs: [
          "A useful payment review should reflect how the business actually collects money. For an auto repair shop, that may include counter payments, deposits before work starts, and occasional payments taken outside the office.",
          "Our team can compare those flows against one statement and prepare a short list of operational questions. There is no claim about savings or rates before the statement is reviewed.",
        ],
      },
      {
        key: "premium-auto-repair-fl-email-4", touch: 4, day: 14,
        subject: "Close the loop on a statement review?",
        paragraphs: [
          "I wanted to close the loop on the offer to review one processing statement for your repair business. The goal is simply to compare your current setup with the way you handle tickets, deposits, and mobile payments.",
          "If the timing is not right, no action is needed. If a brief review would be useful, choose a time and we will keep the conversation to ten minutes.",
        ],
      },
    ],
  },
  {
    key: "premium-medspa-dental",
    name: "Premium Pilot B — Med Spa and Dental",
    audience: "Med spa or dental practices",
    hypothesis: "Deposits, recurring or card-on-file payments, disputes, and front-desk workflow",
    cta: "Second set of eyes on one statement",
    ctaUrl: "https://libertybancard.com/free-analysis",
    sequenceKey: "premium-medspa-dental-sequence",
    manualTaskKey: "premium-medspa-dental-research-call",
    contents: [
      {
        key: "premium-medspa-dental-email-1", touch: 1, day: 1,
        subject: "A second set of eyes on one statement",
        paragraphs: [
          "Practices often combine front-desk payments with deposits, recurring plans, or card-on-file activity. Those flows can affect how staff handle checkout, follow-up, and disputes.",
          "Liberty Bancard can review one current statement alongside the payment workflow you actually use. We will identify questions and options based on retained evidence, without assuming your processor, volume, rates, or pain points. The discussion remains limited to the information you choose to provide, and you decide whether any next step is useful.",
        ],
      },
      {
        key: "premium-medspa-dental-email-2", touch: 2, day: 4,
        subject: "Payment workflow at the front desk",
        paragraphs: [
          "Following up because a statement alone may not show the full front-desk workflow. Deposits, recurring payments, and card-on-file use each create different operational considerations.",
          "A short review can connect the statement details with the way your team collects payments today. We will focus on verifiable information and flag anything that needs confirmation rather than making assumptions. You decide whether a follow-up conversation makes sense, with no obligation to change the process you currently use.",
        ],
      },
      {
        key: "premium-medspa-dental-email-3", touch: 3, day: 8,
        subject: "Reviewing deposits and recurring payments",
        paragraphs: [
          "When a practice uses deposits or recurring payments, the right questions are often operational: how payment details are retained, how disputes are handled, and how staff follow the same process.",
          "We can use one statement as the starting point for a practical comparison. The result is a concise review of the current payment flow, not a promise about rates or savings.",
        ],
      },
      {
        key: "premium-medspa-dental-email-4", touch: 4, day: 14,
        subject: "Should I close this statement review?",
        paragraphs: [
          "I wanted to close the loop on the offer to give one processing statement a second set of eyes. The review can include deposits, recurring payments, card-on-file activity, and front-desk considerations when those are part of the verified workflow.",
          "If it is not useful right now, no action is needed. If you would like the review, send the statement or choose a convenient time.",
        ],
      },
    ],
  },
  {
    key: "premium-home-services",
    name: "Premium Pilot C — Home Services and Construction",
    audience: "Home services and construction businesses",
    hypothesis: "Deposits, remote or mobile collection, payment links, and cash-flow timing",
    cta: "Quick payment-flow comparison",
    ctaUrl: "https://libertybancard.com/free-analysis",
    sequenceKey: "premium-home-services-sequence",
    manualTaskKey: "premium-home-services-research-call",
    contents: [
      {
        key: "premium-home-services-email-1", touch: 1, day: 1,
        subject: "Compare your field payment flow",
        paragraphs: [
          "Home service and construction teams may collect deposits before work, accept payments in the field, or send links after a job. That combination can make payment timing and workflow worth a focused review.",
          "Liberty Bancard can compare one current statement with the verified ways your business collects payments. The review is based on current evidence and does not assume your processor, rates, volume, or challenges.",
        ],
      },
      {
        key: "premium-home-services-email-2", touch: 2, day: 4,
        subject: "Deposits, field payments, and payment links",
        paragraphs: [
          "Following up because deposits, mobile acceptance, and remote payment links can each affect the path from an approved job to collected funds.",
          "We can review one statement and map those payment methods to the current workflow. The goal is a quick comparison with practical questions for your team, without making claims that the available evidence does not support. You can decide whether a follow-up conversation is useful after the comparison, and no action is required.",
        ],
      },
      {
        key: "premium-home-services-email-3", touch: 3, day: 8,
        subject: "A practical payment-flow comparison",
        paragraphs: [
          "Payment workflow matters when work happens away from a fixed counter. The useful details may include when a deposit is collected, who sends a payment link, and how a field payment reaches the office.",
          "A statement review gives us a grounded starting point. We can compare the documented flow and identify items worth confirming, while leaving unsupported assumptions out of the conversation.",
        ],
      },
      {
        key: "premium-home-services-email-4", touch: 4, day: 14,
        subject: "Close the loop on your payment flow?",
        paragraphs: [
          "I wanted to close the loop on the offer to compare your current payment flow with one processing statement. We can include deposits, field collection, and payment links when those methods are supported by retained evidence.",
          "If now is not a good time, no action is needed. If a quick comparison would help, choose a time and we will keep the discussion focused.",
        ],
      },
    ],
  },
] as const;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashCr06(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function hashCr06AuthorizationSnapshot(snapshot: any): string {
  const { asOf: _serverAuthorityTime, ...stableDependencies } = snapshot;
  return hashCr06(stableDependencies);
}

function artifactDefinitions() {
  const v2 = (identity: string) => `${identity}-v2`;
  return PROGRAMS.flatMap((program) => {
    const programDocument = {
      name: program.name,
      audience: program.audience,
      paymentFlowHypothesis: program.hypothesis,
      primaryCta: program.cta,
      sequenceIdentityKey: v2(program.sequenceKey),
      manualTaskIdentityKey: v2(program.manualTaskKey),
      cap: CR06_MAX_PREPARED_MEMBERS,
      channels: ["email"],
      winnerDeclared: false,
    };
    const sequenceDocument = {
      programIdentityKey: v2(program.key),
      cadenceDays: [1, 4, 8, 14],
      channels: ["email"],
      manualTaskAfterTouch: 2,
      rendererVersion: CR06_RENDERER_VERSION,
      contentIdentityKeys: program.contents.map((content) => v2(content.key)),
    };
    const manualTaskDocument = {
      programIdentityKey: v2(program.key),
      trigger: { afterEmailTouch: 2 },
      action: "manual_research_call",
      producer: "cr06",
      title: `Research and call after Email 2 — ${program.name}`,
      idempotent: true,
    };
    return [
      { identityKey: v2(program.key), kind: "program", parentKey: null, document: programDocument },
      { identityKey: v2(program.sequenceKey), kind: "sequence_version", parentKey: v2(program.key), document: sequenceDocument },
      ...program.contents.map((content) => ({
        identityKey: v2(content.key),
        kind: "content_version",
        parentKey: v2(program.sequenceKey),
        document: {
          ...content,
          key: v2(content.key),
          programIdentityKey: v2(program.key),
          callToAction: { label: program.cta, url: program.ctaUrl },
          model: null,
          promptVersion: null,
          riskFlags: [],
          reviewedOnly: true,
        },
      })),
      { identityKey: v2(program.manualTaskKey), kind: "manual_task_definition", parentKey: v2(program.key), document: manualTaskDocument },
    ];
  });
}

export function getCr06RolloutManifest() {
  const artifacts = artifactDefinitions().map((artifact) => ({
    ...artifact,
    version: 2,
    contentHash: hashCr06(artifact.document),
  }));
  const document = {
    manifestVersion: CR06_MANIFEST_VERSION,
    package: "Liberty Bancard Premium Pilots",
    programs: PROGRAMS.map(({ key, name, audience, hypothesis, cta, sequenceKey, manualTaskKey, contents }) => ({
      key: `${key}-v2`, name, audience, hypothesis, cta,
      sequenceKey: `${sequenceKey}-v2`, manualTaskKey: `${manualTaskKey}-v2`,
      contentKeys: contents.map((content) => `${content.key}-v2`),
    })),
    artifacts,
    counts: { programs: 3, sequences: 3, contents: 12, manualTasks: 3 },
    channels: ["email"],
    cadenceDays: [1, 4, 8, 14],
    cap: CR06_MAX_PREPARED_MEMBERS,
    dispatchAvailable: CR06_DISPATCH_AVAILABLE,
  };
  return Object.freeze({ ...document, manifestHash: hashCr06(document) });
}

export async function applyCr06Rollout(input: { actorId: string; dryRun: boolean }) {
  const manifest = getCr06RolloutManifest();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [CR06_MANIFEST_VERSION]);
    const prior = await client.query(
      "SELECT manifest_hash,status,receipt FROM cr06_rollout_manifests WHERE manifest_version=$1 FOR UPDATE",
      [CR06_MANIFEST_VERSION],
    );
    if (prior.rows[0] && prior.rows[0].manifest_hash !== manifest.manifestHash) {
      throw new Error("CR06_MANIFEST_IDENTITY_CONFLICT");
    }
    const existing = await client.query(
      `SELECT identity_key,version,content_hash FROM cr06_artifacts
        WHERE identity_key = ANY($1::text[])`,
      [manifest.artifacts.map((artifact) => artifact.identityKey)],
    );
    const existingMap = new Map(existing.rows.map((row) => [`${row.identity_key}:${row.version}`, row.content_hash]));
    for (const artifact of manifest.artifacts) {
      const currentHash = existingMap.get(`${artifact.identityKey}:${artifact.version}`);
      if (currentHash && currentHash !== artifact.contentHash) throw new Error(`CR06_ARTIFACT_HASH_CONFLICT:${artifact.identityKey}`);
    }
    const receipt = {
      manifestVersion: manifest.manifestVersion,
      manifestHash: manifest.manifestHash,
      counts: manifest.counts,
      existingMatches: existing.rows.length,
      toCreate: manifest.artifacts.length - existing.rows.length,
      dispatchAvailable: false,
    };
    if (
      !input.dryRun &&
      prior.rows[0]?.status === "verified" &&
      existing.rows.length === manifest.artifacts.length &&
      prior.rows[0].receipt
    ) {
      await client.query("COMMIT");
      return { mode: "apply", replayed: true, ...prior.rows[0].receipt };
    }
    if (input.dryRun) {
      await client.query("ROLLBACK");
      return { mode: "dry_run", ...receipt };
    }
    await client.query(
      `INSERT INTO cr06_rollout_manifests
       (manifest_version,manifest_hash,status,program_count,sequence_count,content_count,manual_task_count,document,actor_id,claim_token,lease_expires_at,fence)
       VALUES ($1,$2,'applying',3,3,12,3,$3::jsonb,$4,$5,NOW()+INTERVAL '2 minutes',1)
       ON CONFLICT (manifest_version) DO UPDATE SET
         status='applying', actor_id=EXCLUDED.actor_id, claim_token=EXCLUDED.claim_token,
         lease_expires_at=EXCLUDED.lease_expires_at, fence=cr06_rollout_manifests.fence+1`,
      [manifest.manifestVersion, manifest.manifestHash, JSON.stringify(manifest), input.actorId, randomUUID()],
    );
    const ids = new Map<string, string>();
    for (const artifact of manifest.artifacts) {
      const parentId = artifact.parentKey ? ids.get(artifact.parentKey) : null;
      const inserted = await client.query(
        `INSERT INTO cr06_artifacts
         (identity_key,artifact_kind,record_class,purpose,governance_state,compatibility_state,preparation_state,version,parent_artifact_id,document,content_hash,created_by)
         VALUES ($1,$2,'production','cold_marketing','review_ready','governed','not_prepared',$3,$4,$5::jsonb,$6,$7)
         ON CONFLICT (identity_key,version) DO NOTHING RETURNING id`,
        [artifact.identityKey, artifact.kind, artifact.version, parentId, JSON.stringify(artifact.document), artifact.contentHash, input.actorId],
      );
      const id = inserted.rows[0]?.id ?? (await client.query(
        "SELECT id FROM cr06_artifacts WHERE identity_key=$1 AND version=$2",
        [artifact.identityKey, artifact.version],
      )).rows[0]?.id;
      if (!id) throw new Error(`CR06_ARTIFACT_INSTALL_FAILED:${artifact.identityKey}`);
      ids.set(artifact.identityKey, id);
    }
    // Installing v2 is the explicit operator action that supersedes the prior
    // package. Never rewrite v1 identity, document, hash, parentage, approval,
    // or manifest history. Only the narrow lifecycle projections are advanced.
    const v1IdentityKeys = PROGRAMS.flatMap((program) => [
      program.key,
      program.sequenceKey,
      ...program.contents.map((content) => content.key),
      program.manualTaskKey,
    ]);
    await client.query(
      `UPDATE cr06_artifacts
          SET governance_state=CASE WHEN governance_state='approved_inactive' THEN 'retired' ELSE governance_state END,
              compatibility_state='replaceable',
              preparation_state=CASE WHEN preparation_state IN ('building','ready_held') THEN 'superseded' ELSE preparation_state END,
              retired_at=CASE WHEN governance_state='approved_inactive' THEN COALESCE(retired_at,NOW()) ELSE retired_at END
        WHERE version=1 AND identity_key=ANY($1::text[])`,
      [v1IdentityKeys],
    );
    await client.query(
      `UPDATE cr06_rollout_manifests SET status='verified',receipt=$2::jsonb,applied_at=COALESCE(applied_at,NOW()),
       claim_token=NULL,lease_expires_at=NULL WHERE manifest_version=$1`,
      [manifest.manifestVersion, JSON.stringify(receipt)],
    );
    await client.query("COMMIT");
    return { mode: "apply", replayed: existing.rows.length === manifest.artifacts.length, ...receipt };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function approveCr06Program(input: {
  programArtifactId: string;
  expectedHash: string;
  reviewerId: string;
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const root = await client.query(
      `SELECT * FROM cr06_artifacts WHERE id=$1 AND artifact_kind='program' FOR UPDATE`,
      [input.programArtifactId],
    );
    const program = root.rows[0];
    if (!program) throw new Error("CR06_PROGRAM_NOT_FOUND");
    if (program.content_hash !== input.expectedHash) throw new Error("CR06_APPROVAL_COMPARE_AND_SET_FAILED");
    if (!["review_ready", "approved_inactive"].includes(program.governance_state)) throw new Error("CR06_PROGRAM_NOT_REVIEW_READY");
    const family = await client.query(
      `WITH RECURSIVE family AS (
         SELECT * FROM cr06_artifacts WHERE id=$1
         UNION ALL SELECT a.* FROM cr06_artifacts a JOIN family f ON a.parent_artifact_id=f.id
       ) SELECT * FROM family ORDER BY artifact_kind,identity_key FOR UPDATE`,
      [input.programArtifactId],
    );
    if (family.rows.length !== 7) throw new Error("CR06_PROGRAM_PACKAGE_INCOMPLETE");
    const approvalDependencySnapshot = {
      version: 1,
      manifestHash: getCr06RolloutManifest().manifestHash,
      package: family.rows.map((artifact) => ({
        id: artifact.id, kind: artifact.artifact_kind, identityKey: artifact.identity_key,
        version: artifact.version, governanceState: artifact.governance_state, contentHash: artifact.content_hash,
      })).sort((a, b) => a.identityKey.localeCompare(b.identityKey)),
      sender: { ...resolvePolicy("cold_outreach"), policyVersion: SENDER_POLICY_VERSION },
      renderer: { version: CR06_RENDERER_VERSION, aiModel: null, aiPromptVersion: null },
      policy: { commercialPurpose: "marketing_outreach", dispatchAvailable: CR06_DISPATCH_AVAILABLE },
    };
    const dependencyFingerprint = hashCr06(approvalDependencySnapshot);
    for (const artifact of family.rows) {
      if (!["review_ready", "approved_inactive"].includes(artifact.governance_state)) {
        throw new Error(`CR06_ARTIFACT_NOT_APPROVABLE:${artifact.identity_key}`);
      }
      await client.query(
        `INSERT INTO cr06_approval_snapshots
         (artifact_id,artifact_hash,snapshot,dependency_fingerprint,dependency_snapshot,snapshot_version,reviewer_id,compare_and_set_hash)
          VALUES ($1,$2,$3::jsonb,$4,$5::jsonb,1,$6,$7)
         ON CONFLICT (artifact_id) DO NOTHING`,
        [artifact.id, artifact.content_hash, JSON.stringify(artifact.document), dependencyFingerprint,
          JSON.stringify(approvalDependencySnapshot), input.reviewerId, artifact.content_hash],
      );
      await client.query(
        `UPDATE cr06_artifacts SET governance_state='approved_inactive',reviewed_by=$2,approved_at=COALESCE(approved_at,NOW()),
         dependency_fingerprint=$3 WHERE id=$1 AND content_hash=$4`,
         [artifact.id, input.reviewerId, dependencyFingerprint, artifact.content_hash],
      );
    }
    await client.query("COMMIT");
    return { programArtifactId: program.id, approvedArtifacts: family.rows.length, state: "approved_inactive" };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

type Cr06QueryExecutor = Pick<import("pg").PoolClient, "query">;
const CR06_CONTROL_SETTING_KEYS = [
  "compliance_mailing_address",
  "deliveryWarmupEnabled",
  "deliveryWarmupStartDate",
  "zerobounce_auto_run_enabled",
] as const;
const CR06_UNSUBSCRIBE_SECRET_VERSION = "unsubscribe-hmac-sha256-v1";

function deriveCr06EnvironmentAuthority() {
  let origin: string | null = null;
  let secret: string | null = null;
  try {
    const url = new URL(process.env.APP_URL ?? "");
    if (url.protocol === "https:") origin = url.origin;
  } catch {
    // represented as unavailable below
  }
  try {
    secret = getUnsubscribeTokenSecret();
  } catch {
    // represented as unavailable below
  }
  return {
    origin,
    secret,
    secretFingerprint: secret ? createHash("sha256").update(secret).digest("hex") : null,
    secretVersion: CR06_UNSUBSCRIBE_SECRET_VERSION,
  };
}

function generateSnapshotBoundUnsubscribeToken(contactId: number, secret: string): string {
  const occurrenceId = randomUUID();
  const signature = createHmac("sha256", secret)
    .update(`email_unsubscribe:${contactId}:${occurrenceId}`).digest("hex");
  return `${contactId}.${occurrenceId}.${signature}`;
}

async function lockCr06PreflightDependencies(
  executor: Cr06QueryExecutor,
  programArtifactId: string,
  cohortRunId: string,
  cap: number,
): Promise<void> {
  await executor.query("SELECT id FROM cr06_artifacts WHERE id=$1 FOR UPDATE", [programArtifactId]);
  await executor.query("SELECT id FROM cr04_cohort_runs WHERE id=$1 FOR UPDATE", [cohortRunId]);
  await executor.query(
    `SELECT s.id FROM cr06_approval_snapshots s
       JOIN cr06_artifacts a ON a.id=s.artifact_id
      WHERE a.id=$1 FOR UPDATE OF s`,
    [programArtifactId],
  );
  await executor.query(
    `SELECT run_id,ordinal FROM cr04_cohort_members
      WHERE run_id=$1 ORDER BY ordinal LIMIT $2 FOR UPDATE`,
    [cohortRunId, cap],
  );
  await executor.query(
    `SELECT d.id FROM cr04_channel_decisions d JOIN cr04_cohort_members m ON m.decision_id=d.id
      WHERE m.run_id=$1 AND m.ordinal <= $2 ORDER BY m.ordinal FOR UPDATE OF d`,
    [cohortRunId, cap],
  );
  await executor.query(
    `SELECT c.id FROM contacts c JOIN cr04_cohort_members m ON m.contact_id=c.id
      WHERE m.run_id=$1 AND m.ordinal <= $2 ORDER BY m.ordinal FOR UPDATE OF c`,
    [cohortRunId, cap],
  );
  await executor.query(
    `SELECT p.id FROM provider_observations p JOIN cr04_cohort_members m ON m.contact_id=p.subject_id
      WHERE m.run_id=$1 AND m.ordinal <= $2 AND p.subject_type='contact'
      ORDER BY p.id FOR SHARE OF p`,
    [cohortRunId, cap],
  );
  await executor.query(
    `SELECT id FROM system_settings WHERE key = ANY($1::text[]) ORDER BY key FOR UPDATE`,
    [CR06_CONTROL_SETTING_KEYS],
  );
  await executor.query(
    `SELECT provider FROM provider_controls WHERE provider='zerobounce' FOR UPDATE`,
  );
  await executor.query(
    `SELECT id FROM outbound_send_counters
      WHERE date=CURRENT_DATE AND channel='email' AND scope='cold_outreach' FOR UPDATE`,
  );
}

async function loadPreflightRows(
  programArtifactId: string,
  cohortRunId: string,
  cap: number,
  executor: Cr06QueryExecutor = pool,
) {
  const [program, approval, cohort, members, gate, pause, controlSettings, providerControl, sendCapUsage] = await Promise.all([
    executor.query("SELECT * FROM cr06_artifacts WHERE id=$1 AND artifact_kind='program'", [programArtifactId]),
    executor.query(
      `SELECT s.* FROM cr06_approval_snapshots s JOIN cr06_artifacts a ON a.id=s.artifact_id
       WHERE a.id=$1`,
      [programArtifactId],
    ),
    executor.query(
      `SELECT r.*,d.channel,d.purpose,d.policy_version FROM cr04_cohort_runs r
       JOIN cr04_cohort_definitions d ON d.id=r.definition_id WHERE r.id=$1`,
      [cohortRunId],
    ),
    executor.query(
      `SELECT m.ordinal,m.contact_id,m.decision_id,m.dependency_fingerprint,m.removed_at,m.removal_reason_code,
              c.first_name,c.last_name,c.company_name,c.city,c.email,c.email_status,c.email_mutation_generation,
              c.email_token_hash,c.assigned_to,c.archived_at,c.last_contacted_at,c.do_not_contact,c.opted_out_email,
               c.unsubscribe_status,c.bounce_status,c.complaint_status,c.do_not_auto_contact,c.dnc_reason,
               c.lifecycle_stage,c.record_class,d.decision,d.reason_codes,d.expires_at AS decision_expires_at,
               d.input_snapshot,d.evidence_refs,d.dependency_fingerprint AS decision_dependency_fingerprint,
               EXISTS (
                 SELECT 1 FROM consent_subjects s
                 JOIN consent_subject_channel_states cs ON cs.subject_id=s.id
                 WHERE s.subject_type='contact' AND s.subject_record_id=c.id
                   AND cs.channel='email' AND cs.purpose='outreach'
                   AND cs.permission_state IN ('withdrawn','suppressed')
               ) AS canonical_email_suppressed,
               EXISTS (
                 SELECT 1 FROM contact_merge_operations mo
                 WHERE c.id IN (mo.survivor_contact_id,mo.deprecated_contact_id)
                   AND mo.status IN ('committed','reconciliation_pending')
                   AND COALESCE(mo.reconciliation_status,'') NOT IN ('completed','reconciled')
               ) AS merge_consent_hold,
               po.outcome AS provider_outcome,po.email_token_hash AS provider_email_token_hash,
               po.subject_generation AS provider_subject_generation,po.observed_at AS provider_observed_at
       FROM cr04_cohort_members m
       JOIN contacts c ON c.id=m.contact_id
       JOIN cr04_channel_decisions d ON d.id=m.decision_id
        LEFT JOIN LATERAL (
          SELECT outcome,email_token_hash,subject_generation,observed_at
          FROM provider_observations
          WHERE subject_type='contact' AND subject_id=c.id
            AND email_token_hash=c.email_token_hash
            AND subject_generation=c.email_mutation_generation
          ORDER BY observed_at DESC LIMIT 1
        ) po ON TRUE
       WHERE m.run_id=$1 ORDER BY m.ordinal LIMIT $2`,
      [cohortRunId, cap],
    ),
    executor.query(
      `SELECT * FROM cr06_campaign_gates WHERE program_artifact_id=$1 AND cohort_run_id=$2
       ORDER BY created_at DESC LIMIT 1`,
      [programArtifactId, cohortRunId],
    ),
    executor === pool
      ? getPauseState()
      : executor.query(
          `SELECT state,reason,epoch::text,committed_at
             FROM outbound_pause_control ORDER BY id LIMIT 1 FOR SHARE`,
        ).then((result) => {
          const row = result.rows[0];
          return row
            ? { state: row.state, reason: row.reason, epoch: BigInt(row.epoch), source: "database" as const, committedAt: row.committed_at }
            : { state: "paused" as const, reason: "No control row found", epoch: 0n, source: "safe_default" as const, committedAt: null };
        }),
    executor.query(
      `SELECT id,key,value,updated_at FROM system_settings
        WHERE key = ANY($1::text[]) ORDER BY key`,
      [CR06_CONTROL_SETTING_KEYS],
    ),
    executor.query(
      `SELECT provider,capability,enabled,circuit_state,reserved_units,
              consumed_units,window_started_at,window_ends_at,last_outcome,observed_at,version,updated_at
         FROM provider_controls WHERE provider='zerobounce'`,
    ),
    executor.query(
      `SELECT c.id,CURRENT_DATE::text AS date,'email'::text AS channel,
              'cold_outreach'::text AS scope,COALESCE(c.count,0)::integer AS count,c.updated_at
         FROM (SELECT 1) seed
         LEFT JOIN outbound_send_counters c
           ON c.date=CURRENT_DATE AND c.channel='email' AND c.scope='cold_outreach'`,
    ),
  ]);
  const settingMap = new Map(controlSettings.rows.map((row) => [row.key, row]));
  return {
    program: program.rows[0] ?? null,
    approval: approval.rows[0] ?? null,
    cohort: cohort.rows[0] ?? null,
    members: members.rows,
    gate: gate.rows[0] ?? null,
    pause,
    controlSettings: controlSettings.rows,
    complianceMailingAddress: settingMap.get("compliance_mailing_address")?.value ?? null,
    providerControl: providerControl.rows[0] ?? null,
    sendCapUsage: sendCapUsage.rows[0] ?? null,
  };
}

function memberStaticDisposition(member: any, asOf: Date): { bucket: "eligible" | "blocked" | "deferred"; reasons: string[] } {
  const blocked: string[] = [];
  const deferred: string[] = [];
  if (member.removed_at) blocked.push(member.removal_reason_code || "COHORT_MEMBER_REMOVED");
  if (member.archived_at) blocked.push("CONTACT_ARCHIVED");
  if (member.do_not_contact || member.opted_out_email || member.unsubscribe_status === "unsubscribed") blocked.push("CONSENT_OR_SUPPRESSION");
  if (member.canonical_email_suppressed || member.merge_consent_hold) blocked.push("CONSENT_OR_SUPPRESSION");
  if (member.bounce_status === "hard" || member.complaint_status === "reported") blocked.push("DELIVERY_SUPPRESSED");
  if (member.decision !== "qualified") blocked.push("CR04_NOT_QUALIFIED");
  if (new Date(member.decision_expires_at).getTime() <= asOf.getTime()) deferred.push("CR04_DECISION_STALE");
  if (!member.email || member.email_status !== "valid") deferred.push("EMAIL_NOT_CURRENTLY_VALID");
  if (!member.assigned_to) deferred.push("OWNER_UNAVAILABLE");
  if (member.last_contacted_at && asOf.getTime() - new Date(member.last_contacted_at).getTime() < 7 * 86400000) {
    deferred.push("RECENT_CONTACT_CONFLICT");
  }
  if (blocked.length) return { bucket: "blocked", reasons: [...new Set(blocked)].sort() };
  if (deferred.length) return { bucket: "deferred", reasons: [...new Set(deferred)].sort() };
  return { bucket: "eligible", reasons: [] };
}

export async function preflightCr06(
  input: {
    programArtifactId: string;
    cohortRunId: string;
    cap: number;
    asOf?: Date;
    environmentAuthority?: ReturnType<typeof deriveCr06EnvironmentAuthority>;
  },
  executor: Cr06QueryExecutor = pool,
) {
  const asOf = input.asOf ?? new Date();
  const cap = Math.min(Math.max(input.cap, 1), CR06_MAX_PREPARED_MEMBERS);
  const rows = await loadPreflightRows(input.programArtifactId, input.cohortRunId, cap, executor);
  const environmentAuthority = input.environmentAuthority ?? deriveCr06EnvironmentAuthority();
  const sender = resolvePolicy("cold_outreach");
  const blockers: string[] = [];
  const warnings: string[] = [];
  const unavailable: string[] = [];
  if (!rows.program) blockers.push("PROGRAM_NOT_FOUND");
  else if (rows.program.governance_state !== "approved_inactive") blockers.push("PROGRAM_NOT_APPROVED_INACTIVE");
  if (!rows.approval) blockers.push("APPROVAL_SNAPSHOT_MISSING");
  if (!rows.cohort) blockers.push("COHORT_NOT_FOUND");
  else {
    if (rows.cohort.status !== "frozen") blockers.push("COHORT_NOT_FROZEN");
    if (rows.cohort.channel !== "email") blockers.push("COHORT_CHANNEL_INCOMPATIBLE");
    if (new Date(rows.cohort.expires_at).getTime() <= asOf.getTime()) blockers.push("COHORT_EXPIRED");
  }
  if (rows.pause.state !== "unpaused") warnings.push("GLOBAL_PAUSE_ACTIVE");
  if (!rows.gate || rows.gate.state !== "open" || new Date(rows.gate.expires_at).getTime() <= asOf.getTime()) {
    warnings.push("CAMPAIGN_GATE_CLOSED");
  }
  const memberAuthorities = await Promise.all(rows.members.map(async (member) => {
    const staticDisposition = memberStaticDisposition(member, asOf);
    const provider = decideMarketingEmailValidation(member.email, {
      emailStatus: member.email_status,
      emailTokenHash: member.provider_email_token_hash,
      subjectGeneration: member.email_mutation_generation,
      evidenceGeneration: member.provider_subject_generation,
      verifiedAt: member.provider_observed_at,
      providerOutcome: member.provider_outcome,
    }, asOf);
    const commercialAllowed = member.record_class === "production";
    const contactabilityBlocked = member.do_not_auto_contact || !!member.dnc_reason ||
      member.lifecycle_stage === "do_not_contact" || member.canonical_email_suppressed ||
      member.merge_consent_hold || member.archived_at || member.do_not_contact ||
      member.opted_out_email || member.unsubscribe_status === "unsubscribed";
    const contactability = {
      allowed: !contactabilityBlocked,
      reason: contactabilityBlocked ? "CURRENT_CANONICAL_EMAIL_PERMISSION_BLOCKED" : "Email outreach permitted",
    };
    const mailingAddress = rows.complianceMailingAddress;
    const compliance = typeof mailingAddress === "string" && mailingAddress.trim()
      ? { ok: true as const, mailingAddress: mailingAddress.trim(), unsubscribeUrl: "signed-at-render" }
      : { ok: false as const, error: "COMPLIANCE_MAILING_ADDRESS_MISSING" };
    const reasons = [...staticDisposition.reasons];
    if (!provider.allowed) reasons.push(`PROVIDER:${provider.reason}`);
    if (!commercialAllowed) reasons.push("COMMERCIAL_AUTHORITY_BLOCKED");
    if (!contactability.allowed && contactability.reason !== "outside_business_hours") reasons.push(`CONTACTABILITY:${contactability.reason}`);
    if (!compliance.ok) reasons.push(compliance.error);
    const bucket = reasons.length
      ? (staticDisposition.bucket === "blocked" ? "blocked" : "deferred")
      : "eligible";
    return {
      ordinal: member.ordinal, contactId: member.contact_id, bucket,
      reasons: [...new Set(reasons)].sort(),
      cr04: { decisionId: member.decision_id, decision: member.decision,
        expiresAt: new Date(member.decision_expires_at).toISOString(),
        dependencyFingerprint: member.dependency_fingerprint, inputSnapshot: member.input_snapshot, evidenceRefs: member.evidence_refs },
      provider: { allowed: provider.allowed, decision: provider.decision, reason: provider.reason,
        emailTokenHash: provider.emailTokenHash, subjectGeneration: provider.subjectGeneration,
        evidenceAt: provider.evidenceAt?.toISOString() ?? null },
      commercial: { allowed: commercialAllowed, snapshotId: null },
      contactability: { allowed: contactability.allowed, reason: contactability.reason },
      compliance: compliance.ok
        ? { ok: true, mailingAddress: compliance.mailingAddress, unsubscribeMode: compliance.unsubscribeUrl ? "signed_url" : "reply_instruction",
          // A signed unsubscribe occurrence is generated only while rendering
          // the held recipient snapshot. Including that random occurrence URL
          // in read-only preflight made two equal authority reads hash
          // differently and made an exact gate impossible to consume.
        }
        : { ok: false, error: compliance.error },
    };
  }));
  const dispositions = memberAuthorities.map(({ ordinal, contactId, bucket, reasons }) => ({ ordinal, contactId, bucket, reasons }));
  const summary = dispositions.reduce((acc, item) => {
    acc[item.bucket as keyof typeof acc] += 1;
    return acc;
  }, { eligible: 0, blocked: 0, deferred: 0 });
  if (!sender.from || !sender.replyTo) unavailable.push("SENDER_POLICY_UNAVAILABLE");
  if (!environmentAuthority.origin) unavailable.push("COMPLIANCE_APP_URL_INVALID");
  if (!environmentAuthority.secretFingerprint) unavailable.push("COMPLIANCE_UNSUBSCRIBE_SECRET_MISSING");
  if (!rows.providerControl) unavailable.push("PROVIDER_CONTROL_UNAVAILABLE");
  else {
    if (!rows.providerControl.enabled) blockers.push("PROVIDER_DISABLED");
    if (rows.providerControl.circuit_state !== "closed") blockers.push("PROVIDER_CIRCUIT_NOT_CLOSED");
  }
  if (!rows.controlSettings.some((row) => row.key === "compliance_mailing_address")) {
    unavailable.push("COMPLIANCE_CONFIGURATION_UNAVAILABLE");
  }
  const packageRows = rows.program ? await executor.query(
    `WITH RECURSIVE family AS (
       SELECT * FROM cr06_artifacts WHERE id=$1 UNION ALL
       SELECT a.* FROM cr06_artifacts a JOIN family f ON a.parent_artifact_id=f.id
     ) SELECT identity_key,artifact_kind,version,content_hash,governance_state,document FROM family ORDER BY identity_key`,
    [rows.program.id],
  ) : { rows: [] as any[] };
  const normalizeSetting = (row: any) => row ? {
    id: row.id,
    key: row.key,
    value: row.value,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  } : null;
  const normalizedProviderControl = rows.providerControl ? {
    provider: rows.providerControl.provider,
    capability: rows.providerControl.capability,
    enabled: rows.providerControl.enabled,
    circuitState: rows.providerControl.circuit_state,
    reservedUnits: rows.providerControl.reserved_units,
    consumedUnits: rows.providerControl.consumed_units,
    windowStartedAt: rows.providerControl.window_started_at
      ? new Date(rows.providerControl.window_started_at).toISOString() : null,
    windowEndsAt: rows.providerControl.window_ends_at
      ? new Date(rows.providerControl.window_ends_at).toISOString() : null,
    lastOutcome: rows.providerControl.last_outcome,
    observedAt: rows.providerControl.observed_at
      ? new Date(rows.providerControl.observed_at).toISOString() : null,
    version: rows.providerControl.version,
    updatedAt: new Date(rows.providerControl.updated_at).toISOString(),
  } : null;
  const normalizedSendCapUsage = {
    id: rows.sendCapUsage.id,
    date: rows.sendCapUsage.date,
    channel: rows.sendCapUsage.channel,
    scope: rows.sendCapUsage.scope,
    count: rows.sendCapUsage.count,
    updatedAt: rows.sendCapUsage.updated_at
      ? new Date(rows.sendCapUsage.updated_at).toISOString() : null,
  };
  const dependencySnapshot = {
    version: 1,
    asOf: asOf.toISOString(),
    manifest: { version: CR06_MANIFEST_VERSION, hash: getCr06RolloutManifest().manifestHash },
    approval: rows.approval ? { id: rows.approval.id, dependencyFingerprint: rows.approval.dependency_fingerprint,
      dependencySnapshot: rows.approval.dependency_snapshot, snapshotVersion: rows.approval.snapshot_version } : null,
    package: packageRows.rows.map((row) => ({ identityKey: row.identity_key, kind: row.artifact_kind, version: row.version,
      hash: row.content_hash, state: row.governance_state, aiModel: row.document?.model ?? null, aiPromptVersion: row.document?.promptVersion ?? null })),
    cohort: rows.cohort ? { id: rows.cohort.id, status: rows.cohort.status, buildPhase: rows.cohort.build_phase,
      expiresAt: new Date(rows.cohort.expires_at).toISOString(),
      memberCount: rows.cohort.member_count, membershipFingerprint: rows.cohort.membership_fingerprint,
      definition: { id: rows.cohort.definition_id, channel: rows.cohort.channel, purpose: rows.cohort.purpose, policyVersion: rows.cohort.policy_version },
      members: memberAuthorities } : null,
    sender: { ...sender, policyVersion: SENDER_POLICY_VERSION, signature: "Business Development\n954-266-8214" },
    compliance: {
      purpose: "marketing_outreach",
      unsubscribe: "per-recipient signed URL",
      appOrigin: environmentAuthority.origin,
      unsubscribeSecret: {
        version: environmentAuthority.secretVersion,
        fingerprint: environmentAuthority.secretFingerprint,
      },
      setting: normalizeSetting(rows.controlSettings.find((row) => row.key === "compliance_mailing_address")),
    },
    providerReadiness: {
      members: memberAuthorities.map((member) => ({ ordinal: member.ordinal, provider: member.provider })),
      control: normalizedProviderControl,
    },
    caps: {
      requested: cap,
      maximum: CR06_MAX_PREPARED_MEMBERS,
      senderCampaignProviderCanary: rows.controlSettings
        .filter((row) => row.key !== "compliance_mailing_address")
        .map(normalizeSetting),
      currentColdOutreachUsage: normalizedSendCapUsage,
    },
    pause: { state: rows.pause.state, epoch: rows.pause.epoch.toString(), source: rows.pause.source },
    renderer: { version: CR06_RENDERER_VERSION, aiModel: null, aiPromptVersion: null },
    dispatchAvailable: CR06_DISPATCH_AVAILABLE,
  };
  const report = {
    lifecycle: {
      governance: rows.program?.governance_state ?? "unavailable",
      preparation: rows.program?.preparation_state ?? "unavailable",
      dispatch: "held",
    },
    manifest: { version: CR06_MANIFEST_VERSION, hash: getCr06RolloutManifest().manifestHash },
    program: rows.program ? { id: rows.program.id, identityKey: rows.program.identity_key, contentHash: rows.program.content_hash } : null,
    approval: rows.approval ? { id: rows.approval.id, dependencyFingerprint: rows.approval.dependency_fingerprint, approvedAt: rows.approval.approved_at } : null,
    cohort: rows.cohort ? {
      id: rows.cohort.id, status: rows.cohort.status, generation: rows.cohort.fence ?? 0,
      memberCount: rows.cohort.member_count, membershipFingerprint: rows.cohort.membership_fingerprint,
      policyVersion: rows.cohort.policy_version, cap,
    } : null,
    sender: { ...sender, policyVersion: SENDER_POLICY_VERSION, operationalReadiness: "not_probed_read_only" },
    authorities: {
      globalPause: rows.pause.state,
      campaignGate: rows.gate?.state ?? "closed",
      dispatchAvailable: CR06_DISPATCH_AVAILABLE,
      quietHours: "enforced_at_release",
      consent: "rechecked_at_prepare_and_release",
      contactability: "rechecked_at_prepare_and_release",
    },
    summary,
    dispositions,
    blockers: [...new Set(blockers)].sort(),
    warnings: [...new Set(warnings)].sort(),
    unavailable: [...new Set(unavailable)].sort(),
    asOf: asOf.toISOString(),
    dependencySnapshot,
    dependencyHash: hashCr06(dependencySnapshot),
  };
  // The command hash deliberately covers only the canonical authority
  // snapshot. Presentation fields (including whether a gate already exists)
  // must not make an otherwise identical governed command stale.
  return {
    ...report,
    preflightHash: hashCr06AuthorizationSnapshot(dependencySnapshot),
    eligible: blockers.length === 0 && unavailable.length === 0,
  };
}

export async function setCr06CampaignGate(input: {
  programArtifactId: string;
  cohortRunId: string;
  preflightHash: string;
  cap: number;
  state: "open" | "closed";
  confirmation?: string;
  actorId: string;
  idempotencyKey: string;
  expiresAt: Date;
}) {
  if (input.cap < 1 || input.cap > CR06_MAX_PREPARED_MEMBERS) throw new Error("CR06_CAP_OUT_OF_RANGE");
  if (input.state === "open" && input.confirmation !== CR06_GATE_CONFIRMATION) throw new Error("CR06_GATE_CONFIRMATION_REQUIRED");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`cr06-gate:${input.programArtifactId}:${input.cohortRunId}`]);
    const replay = await client.query("SELECT * FROM cr06_campaign_gates WHERE idempotency_key=$1 FOR UPDATE", [input.idempotencyKey]);
    if (replay.rows[0]) {
      const row = replay.rows[0];
      if (row.program_artifact_id !== input.programArtifactId || row.cohort_run_id !== input.cohortRunId ||
          row.preflight_hash !== input.preflightHash || row.cap !== input.cap || row.state !== input.state) {
        throw new Error("CR06_IDEMPOTENCY_KEY_CONFLICT");
      }
      await client.query("COMMIT");
      return row;
    }
    await lockCr06PreflightDependencies(
      client,
      input.programArtifactId,
      input.cohortRunId,
      input.cap,
    );
    const serverClock = await client.query("SELECT clock_timestamp() AS now");
    const serverAsOf = new Date(serverClock.rows[0].now);
    const preflight = await preflightCr06({
      programArtifactId: input.programArtifactId,
      cohortRunId: input.cohortRunId,
      cap: input.cap,
      asOf: serverAsOf,
    }, client);
    if (preflight.preflightHash !== input.preflightHash) throw new Error("CR06_PREFLIGHT_HASH_STALE");
    if (input.state === "open" && !preflight.eligible) throw new Error("CR06_PREFLIGHT_BLOCKED");
    if (input.state === "open" && input.expiresAt.getTime() <= serverAsOf.getTime()) {
      throw new Error("CR06_GATE_EXPIRY_REQUIRED");
    }
    const approvalId = preflight.approval?.id;
    if (!approvalId) throw new Error("CR06_APPROVAL_MISSING");
    await client.query(
      `UPDATE cr06_campaign_gates
          SET state='closed',closed_at=NOW(),revision=revision+1,actor_id=$3
       WHERE program_artifact_id=$1 AND cohort_run_id=$2 AND state='open'`,
      [input.programArtifactId, input.cohortRunId, input.actorId],
    );
    const revisionResult = await client.query(
      `SELECT COALESCE(MAX(revision),0)::integer + 1 AS revision
         FROM cr06_campaign_gates WHERE program_artifact_id=$1 AND cohort_run_id=$2`,
      [input.programArtifactId, input.cohortRunId],
    );
    const revision = revisionResult.rows[0].revision;
    const result = await client.query(
       `INSERT INTO cr06_campaign_gates
        (program_artifact_id,cohort_run_id,approval_id,preflight_hash,dependency_snapshot,revision,cap,state,confirmation,actor_id,idempotency_key,expires_at,opened_at,closed_at)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,
          CASE WHEN $8='open' THEN NOW() END,CASE WHEN $8='closed' THEN NOW() END) RETURNING *`,
       [input.programArtifactId, input.cohortRunId, approvalId, input.preflightHash, JSON.stringify(preflight.dependencySnapshot),
         revision, input.cap, input.state, input.confirmation ?? null, input.actorId, input.idempotencyKey, input.expiresAt],
    );
    await client.query("COMMIT");
    return result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function prepareCr06(input: {
  programArtifactId: string;
  cohortRunId: string;
  cap: number;
  actorId: string;
  idempotencyKey: string;
}) {
  if (input.cap < 1 || input.cap > CR06_MAX_PREPARED_MEMBERS) throw new Error("CR06_CAP_OUT_OF_RANGE");
  const environmentAuthority = deriveCr06EnvironmentAuthority();
  const replay = await pool.query("SELECT * FROM cr06_preparation_runs WHERE idempotency_key=$1", [input.idempotencyKey]);
  if (replay.rows[0]) {
    const row = replay.rows[0];
    if (row.program_artifact_id !== input.programArtifactId || row.cohort_run_id !== input.cohortRunId || row.requested_count > input.cap) {
      throw new Error("CR06_IDEMPOTENCY_KEY_CONFLICT");
    }
    if (row.state === "ready_held") return { ...row, replayed: true };
  }
  const sender = resolvePolicy("cold_outreach");
  const runId = randomUUID();
  const client = await pool.connect();
  const preparedIds = new Map<number, string>();
  let dispositions: Array<{ contactId: number; bucket: "blocked" | "deferred"; reasons: string[] }> = [];
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`cr06:${input.cohortRunId}:${input.programArtifactId}`]);
    // The governed inputs are locked before the authoritative re-read.  This
    // makes preparation a compare-and-consume command rather than a trust of a
    // browser preflight result.
    // Lock the exact frozen membership, its decisions, current contacts, and
    // provider/consent evidence before deriving anything that can authorize a
    // held intent. Restrictive drift may remove a member; it can never add one.
    await lockCr06PreflightDependencies(
      client,
      input.programArtifactId,
      input.cohortRunId,
      input.cap,
    );
    const lockedGate = await client.query(
      `SELECT * FROM cr06_campaign_gates WHERE program_artifact_id=$1 AND cohort_run_id=$2
       AND state='open' AND expires_at>NOW() ORDER BY revision DESC, created_at DESC LIMIT 1 FOR UPDATE`,
      [input.programArtifactId, input.cohortRunId],
    );
    const gate = lockedGate.rows[0];
    if (!gate || Number(gate.cap) !== input.cap) throw new Error("CR06_EXACT_CAMPAIGN_GATE_NOT_OPEN");
    const serverClock = await client.query("SELECT clock_timestamp() AS now");
    const currentAsOf = new Date(serverClock.rows[0].now);
    const exactPreflight = await preflightCr06({
      programArtifactId: input.programArtifactId, cohortRunId: input.cohortRunId, cap: input.cap, asOf: currentAsOf,
      environmentAuthority,
    }, client);
    if (!exactPreflight.eligible ||
        hashCr06AuthorizationSnapshot(exactPreflight.dependencySnapshot) !==
          hashCr06AuthorizationSnapshot(gate.dependency_snapshot) ||
        exactPreflight.preflightHash !== gate.preflight_hash) {
      throw new Error("CR06_GATE_DEPENDENCY_SNAPSHOT_STALE");
    }
    const dependencyFingerprint = exactPreflight.dependencyHash;
    const rows = await loadPreflightRows(input.programArtifactId, input.cohortRunId, input.cap, client);
    const packageRows = await client.query(
      `WITH RECURSIVE family AS (
         SELECT * FROM cr06_artifacts WHERE id=$1
         UNION ALL SELECT a.* FROM cr06_artifacts a JOIN family f ON a.parent_artifact_id=f.id
       ) SELECT * FROM family WHERE governance_state='approved_inactive'`,
      [input.programArtifactId],
    );
    const sequence = packageRows.rows.find((row) => row.artifact_kind === "sequence_version");
    const contents = packageRows.rows.filter((row) => row.artifact_kind === "content_version")
      .sort((a, b) => Number(a.document.touch) - Number(b.document.touch));
    const taskDefinition = packageRows.rows.find((row) => row.artifact_kind === "manual_task_definition");
    if (!sequence || contents.length !== 4 || !taskDefinition) throw new Error("CR06_APPROVED_PACKAGE_INCOMPLETE");
    const authorityMembers = new Map(
      (exactPreflight.dependencySnapshot.cohort?.members ?? []).map((member: any) => [member.contactId, member]),
    );
    const eligible: Array<{ member: any; content: any[]; sequenceId: string }> = [];
    dispositions = [];
    for (const member of rows.members) {
      const authority = authorityMembers.get(member.contact_id) as any;
      if (!authority || authority.bucket !== "eligible") {
        dispositions.push({
          contactId: member.contact_id,
          bucket: authority?.bucket === "blocked" ? "blocked" : "deferred",
          reasons: authority?.reasons ?? ["CURRENT_AUTHORITY_UNAVAILABLE"],
        });
        continue;
      }
      if (member.decision !== "qualified" ||
          member.decision_dependency_fingerprint !== member.dependency_fingerprint ||
          !member.input_snapshot?.authorityFingerprint) {
        dispositions.push({ contactId: member.contact_id, bucket: "deferred", reasons: ["CR04_MEMBER_FINGERPRINT_DRIFT"] });
        continue;
      }
      eligible.push({ member, content: contents, sequenceId: sequence.id });
    }
    const complianceRows = new Map<number, { ok: true; mailingAddress: string; unsubscribeUrl: string } | { ok: false; error: string }>();
    for (const item of eligible) {
      const complianceSnapshot = exactPreflight.dependencySnapshot.compliance;
      try {
        const mailingAddress = complianceSnapshot.setting?.value;
        if (typeof mailingAddress !== "string" || !mailingAddress.trim()) {
          throw new Error("COMPLIANCE_MAILING_ADDRESS_MISSING");
        }
        if (!complianceSnapshot.appOrigin || !environmentAuthority.secret ||
            complianceSnapshot.unsubscribeSecret.fingerprint !== environmentAuthority.secretFingerprint) {
          throw new Error("COMPLIANCE_UNSUBSCRIBE_AUTHORITY_STALE");
        }
        complianceRows.set(item.member.contact_id, {
          ok: true,
          mailingAddress: mailingAddress.trim(),
          unsubscribeUrl: `${complianceSnapshot.appOrigin}/unsubscribe?t=${encodeURIComponent(
            generateSnapshotBoundUnsubscribeToken(item.member.contact_id, environmentAuthority.secret),
          )}`,
        });
      } catch (error) {
        complianceRows.set(item.member.contact_id, {
          ok: false,
          error: error instanceof Error && error.message.startsWith("COMPLIANCE_")
            ? error.message
            : "COMPLIANCE_UNSUBSCRIBE_SECRET_MISSING",
        });
      }
    }
    const existing = await client.query("SELECT * FROM cr06_preparation_runs WHERE idempotency_key=$1 FOR UPDATE", [input.idempotencyKey]);
    if (existing.rows[0]) {
      await client.query("ROLLBACK");
      return { ...existing.rows[0], replayed: true };
    }
    await client.query(
      `INSERT INTO cr06_preparation_runs
       (id,idempotency_key,program_artifact_id,approval_id,cohort_run_id,dependency_fingerprint,state,requested_count,
         blocked_count,deferred_count,claim_token,lease_expires_at,fence,blocker_summary,dependency_snapshot,dependency_version,created_by)
        VALUES ($1,$2,$3,$4,$5,$6,'building',$7,$8,$9,$10,NOW()+INTERVAL '2 minutes',1,$11::jsonb,$12::jsonb,1,$13)`,
      [runId, input.idempotencyKey, input.programArtifactId, exactPreflight.approval!.id, input.cohortRunId,
        dependencyFingerprint, rows.members.length,
        dispositions.filter((d) => d.bucket === "blocked").length,
        dispositions.filter((d) => d.bucket === "deferred").length,
         randomUUID(), JSON.stringify(dispositions), JSON.stringify(exactPreflight.dependencySnapshot), input.actorId],
    );
    for (const item of eligible) {
      const current = (await client.query(
        `SELECT c.email_mutation_generation,c.email_token_hash,c.email,c.first_name,c.company_name,c.city,c.assigned_to,
                c.record_class,c.do_not_contact,c.opted_out_email,c.unsubscribe_status,c.bounce_status,c.complaint_status,
                EXISTS (
                  SELECT 1 FROM consent_subjects s
                  JOIN consent_subject_channel_states cs ON cs.subject_id=s.id
                  WHERE s.subject_type='contact' AND s.subject_record_id=c.id
                    AND cs.channel='email' AND cs.purpose='outreach'
                    AND cs.permission_state IN ('withdrawn','suppressed')
                ) AS canonical_email_suppressed,
                (SELECT p.outcome FROM provider_observations p
                  WHERE p.subject_type='contact' AND p.subject_id=c.id
                    AND p.email_token_hash=c.email_token_hash
                    AND p.subject_generation=c.email_mutation_generation
                  ORDER BY p.observed_at DESC LIMIT 1) AS current_provider_outcome
         FROM contacts c WHERE c.id=$1 FOR UPDATE`,
        [item.member.contact_id],
      )).rows[0];
      if (!current || current.email_mutation_generation !== item.member.email_mutation_generation ||
          current.email_token_hash !== item.member.email_token_hash || current.email !== item.member.email) {
        dispositions.push({ contactId: item.member.contact_id, bucket: "deferred", reasons: ["CONTACT_GENERATION_CHANGED"] });
        continue;
      }
      if (current.record_class !== "production" || current.do_not_contact || current.opted_out_email ||
          current.unsubscribe_status === "unsubscribed" || current.bounce_status === "hard" ||
          current.complaint_status === "reported" || current.canonical_email_suppressed ||
          current.current_provider_outcome !== "valid") {
        dispositions.push({
          contactId: item.member.contact_id,
          bucket: current.record_class !== "production" || current.do_not_contact ||
            current.opted_out_email || current.canonical_email_suppressed ? "blocked" : "deferred",
          reasons: ["CURRENT_MEMBER_AUTHORITY_DRIFT"],
        });
        continue;
      }
      const enrollment = await client.query(
        `INSERT INTO cr06_prepared_enrollments
         (preparation_run_id,cohort_ordinal,contact_id,contact_generation,email_token_hash,sender_policy_version,
          dependency_fingerprint,evidence_snapshot,state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'ready_held') RETURNING id`,
        [runId, item.member.ordinal, item.member.contact_id, current.email_mutation_generation, current.email_token_hash,
          SENDER_POLICY_VERSION, dependencyFingerprint, JSON.stringify({
            companyName: current.company_name, city: current.city, assignedTo: current.assigned_to,
            decisionId: item.member.decision_id, decisionFingerprint: item.member.dependency_fingerprint,
            evidenceRefs: item.member.evidence_refs, inputSnapshot: item.member.input_snapshot,
          })],
      );
      const preparedId = enrollment.rows[0].id;
      preparedIds.set(item.member.contact_id, preparedId);
      const compliance = complianceRows.get(item.member.contact_id)!;
      if (!compliance.ok) throw new Error(compliance.error);
      for (const contentRow of item.content) {
        const content = contentRow.document as ContentDefinition & { callToAction: { label: string; url: string } };
        const rendered = renderCr06Recipient({
          rendererVersion: CR06_RENDERER_VERSION,
          purpose: "commercial_outreach",
          content: {
            subject: content.subject,
            greeting: `Hi ${current.first_name?.trim() || "there"},`,
            paragraphs: content.paragraphs,
            callToAction: content.callToAction,
          },
          sender: {
            displayName: sender.displayName,
            email: sender.from,
            signature: "Business Development\n954-266-8214",
          },
          compliance: {
            mailingAddress: compliance.mailingAddress,
            unsubscribe: compliance.unsubscribeUrl
              ? { url: compliance.unsubscribeUrl }
              : { instruction: "Reply unsubscribe and we will stop future emails." },
          },
        });
        const scheduledFor = new Date(Date.now() + (content.day - 1) * 86400000);
        await client.query(
          `INSERT INTO cr06_delivery_intents
           (preparation_run_id,prepared_enrollment_id,sequence_artifact_id,content_artifact_id,touch_number,scheduled_for,
             state,recipient_snapshot,render_hash,provider_attempt_count,dependency_snapshot,dependency_version)
            VALUES ($1,$2,$3,$4,$5,$6,'held',$7::jsonb,$8,0,$9::jsonb,1)`,
          [runId, preparedId, item.sequenceId, contentRow.id, content.touch, scheduledFor,
            JSON.stringify({
              to: current.email, subject: rendered.subject, text: rendered.text, html: rendered.html,
              textHash: rendered.textSha256, htmlHash: rendered.htmlSha256,
              sender: { from: sender.from, replyTo: sender.replyTo, displayName: sender.displayName, policyVersion: SENDER_POLICY_VERSION },
             }), hashCr06(rendered), JSON.stringify(exactPreflight.dependencySnapshot)],
        );
      }
      await client.query(
        `INSERT INTO cr06_manual_task_intents
         (preparation_run_id,prepared_enrollment_id,task_definition_artifact_id,trigger_touch_number,state,scheduled_after,command_key)
         VALUES ($1,$2,$3,2,'held',$4,$5)`,
        [runId, preparedId, taskDefinition.id, new Date(Date.now() + 4 * 86400000), `cr06:${runId}:${item.member.contact_id}:post-email-2`],
      );
      await client.query(
        `INSERT INTO cr06_attribution_events
         (preparation_run_id,contact_id,event_type,outcome,payload)
         VALUES ($1,$2,'prepared','success',$3::jsonb)`,
        [runId, item.member.contact_id, JSON.stringify({ cohortOrdinal: item.member.ordinal, state: "ready_held" })],
      );
    }
    const runHash = hashCr06({
      programArtifactId: input.programArtifactId,
      cohortRunId: input.cohortRunId,
      dependencyFingerprint,
      prepared: [...preparedIds.entries()].sort(([a], [b]) => a - b),
    });
    // Reservations are evidence for every independently limiting authority,
    // rather than a single ambiguous "campaign" reservation.  They have zero
    // effective/send capacity while final dispatch is unavailable; the member
    // cap records only immutable held work.  Build and persist all seven rows
    // in this transaction, under one receipt, after the final member recheck.
    const reservationNow = currentAsOf;
    const minuteWindow = new Date(reservationNow);
    minuteWindow.setUTCSeconds(0, 0);
    const hourWindow = new Date(reservationNow);
    hourWindow.setUTCMinutes(0, 0, 0);
    const dayWindow = new Date(reservationNow);
    dayWindow.setUTCHours(0, 0, 0, 0);
    const reservationScopes = [
      { type: "sender", identity: sender.from, window: null, usage: 0 },
      { type: "campaign", identity: input.programArtifactId, window: null, usage: 0 },
      { type: "provider", identity: "zerobounce", window: null, usage: 0 },
      { type: "minute", identity: "cold_outreach:email", window: minuteWindow, usage: 0 },
      { type: "hour", identity: "cold_outreach:email", window: hourWindow, usage: 0 },
      { type: "day", identity: "cold_outreach:email", window: dayWindow, usage: Number(rows.sendCapUsage?.count ?? 0) },
      { type: "canary", identity: CR06_MANIFEST_VERSION, window: null, usage: 0 },
    ] as const;
    const reservationReceipt = {
      receiptVersion: 1,
      dispatchAvailable: CR06_DISPATCH_AVAILABLE,
      preparationRunId: runId,
      programArtifactId: input.programArtifactId,
      cohortRunId: input.cohortRunId,
      gateId: gate.id,
      gateRevision: Number(gate.revision),
      reservedMemberCap: preparedIds.size,
      effectiveCap: 0,
      sendCapacityUnits: 0,
      expiresAt: new Date(gate.expires_at).toISOString(),
      scopes: reservationScopes.map((scope) => ({
        type: scope.type, identity: scope.identity, window: scope.window?.toISOString() ?? null, currentUsage: scope.usage,
      })),
    };
    const reservationReceiptHash = hashCr06(reservationReceipt);
    for (const scope of reservationScopes) {
      await client.query(
        `INSERT INTO cr06_preparation_reservations
         (preparation_run_id,reservation_key,scope_type,scope_identity,scope_window,reserved_members,
          reserved_member_cap,effective_cap,current_usage,send_capacity_units,dependency_snapshot,
          receipt,receipt_hash,expires_at,state)
         VALUES ($1,$2,$3,$4,$5,$6,$6,0,$7,0,$8::jsonb,$9::jsonb,$10,$11,'held')`,
        [runId,
          `cr06:${runId}:${scope.type}`,
          scope.type, scope.identity, scope.window, preparedIds.size, scope.usage,
          JSON.stringify(exactPreflight.dependencySnapshot), JSON.stringify(reservationReceipt),
          reservationReceiptHash, gate.expires_at],
      );
    }
    const runReceipt = {
      receiptVersion: 1,
      state: "ready_held",
      requestedCount: rows.members.length,
      preparedCount: preparedIds.size,
      blockedCount: dispositions.filter((d) => d.bucket === "blocked").length,
      deferredCount: dispositions.filter((d) => d.bucket === "deferred").length,
      runHash,
      dependencyFingerprint,
      reservationReceiptHash,
      reservationScopeCount: reservationScopes.length,
      dispatchAvailable: CR06_DISPATCH_AVAILABLE,
    };
    await client.query(
      `UPDATE cr06_preparation_runs SET state='ready_held',prepared_count=$2,blocked_count=$3,deferred_count=$4,
       run_hash=$5,blocker_summary=$6::jsonb,receipt=$7::jsonb,
       claim_token=NULL,lease_expires_at=NULL,completed_at=NOW()
       WHERE id=$1`,
      [runId, preparedIds.size,
        dispositions.filter((d) => d.bucket === "blocked").length,
        dispositions.filter((d) => d.bucket === "deferred").length,
        runHash, JSON.stringify(dispositions), JSON.stringify(runReceipt)],
    );
    await client.query(
      `UPDATE cr06_artifacts SET preparation_state='ready_held' WHERE id=$1`,
      [input.programArtifactId],
    );
    const consumed = await client.query(
      `UPDATE cr06_campaign_gates
          SET state='closed',closed_at=NOW(),revision=revision+1,actor_id=$3
        WHERE id=$1 AND revision=$2 AND state='open' RETURNING id`,
      [gate.id, gate.revision, input.actorId],
    );
    if (!consumed.rows[0]) throw new Error("CR06_GATE_REVISION_CONSUME_FAILED");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return {
    id: runId,
    state: "ready_held",
    statusLabel: "READY_HELD — SENDING OFF",
    preparedCount: preparedIds.size,
    blockedCount: dispositions.filter((d) => d.bucket === "blocked").length,
    deferredCount: dispositions.filter((d) => d.bucket === "deferred").length,
    providerAttemptCount: 0,
    dispatchAvailable: false,
    replayed: false,
  };
}

export type Cr06ReservationTransition = "expired" | "reconciled" | "superseded";

export async function reconcileCr06PreparationReservations(input: {
  preparationRunId: string;
  transition: Cr06ReservationTransition;
  actorId: string;
  idempotencyKey: string;
  reason?: string;
}) {
  if (!input.idempotencyKey || input.idempotencyKey.length < 8) {
    throw new Error("CR06_RESERVATION_IDEMPOTENCY_KEY_REQUIRED");
  }
  if (input.transition !== "expired" && !input.reason?.trim()) {
    throw new Error("CR06_RESERVATION_RECONCILIATION_REASON_REQUIRED");
  }
  if (input.transition === "expired" && input.reason?.trim()) {
    throw new Error("CR06_RESERVATION_RECONCILIATION_CONFLICT");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [`cr06:reservation:${input.preparationRunId}`],
    );
    const run = await client.query(
      "SELECT id FROM cr06_preparation_runs WHERE id=$1",
      [input.preparationRunId],
    );
    if (!run.rows[0]) throw new Error("CR06_PREPARATION_RUN_NOT_FOUND");
    const current = await client.query(
      `SELECT * FROM cr06_preparation_reservations
        WHERE preparation_run_id=$1 ORDER BY scope_type FOR UPDATE`,
      [input.preparationRunId],
    );
    const requiredScopes = ["campaign", "canary", "day", "hour", "minute", "provider", "sender"];
    if (current.rowCount !== requiredScopes.length ||
        current.rows.map((row) => row.scope_type).join(",") !== requiredScopes.join(",")) {
      throw new Error("CR06_RESERVATION_SCOPE_SET_INCOMPLETE");
    }
    const states = new Set(current.rows.map((row) => row.state));
    if (states.size === 1 && states.has(input.transition)) {
      const first = current.rows[0];
      const expectedReason = input.transition === "expired"
        ? "reservation_ttl_elapsed"
        : input.reason!.trim();
      if (current.rows.some((row) =>
        row.reconciliation_key !== input.idempotencyKey ||
        row.reconciliation_receipt_hash !== first.reconciliation_receipt_hash ||
        JSON.stringify(row.reconciliation_receipt) !== JSON.stringify(first.reconciliation_receipt) ||
        row.reconciliation_receipt?.actorId !== input.actorId ||
        row.reconciliation_receipt?.reason !== expectedReason ||
        row.reconciliation_receipt?.transition !== input.transition)) {
        throw new Error("CR06_RESERVATION_RECONCILIATION_CONFLICT");
      }
      await client.query("COMMIT");
      return {
        preparationRunId: input.preparationRunId,
        transition: input.transition,
        affectedScopes: requiredScopes.length,
        receipt: first.reconciliation_receipt,
        receiptHash: first.reconciliation_receipt_hash,
        replayed: true,
      };
    }
    if (states.size !== 1 || !states.has("held")) {
      throw new Error("CR06_RESERVATION_RECONCILIATION_CONFLICT");
    }
    const clock = await client.query("SELECT clock_timestamp() AS as_of");
    const asOf = new Date(clock.rows[0].as_of);
    if (input.transition === "expired" &&
        current.rows.some((row) => asOf < new Date(row.expires_at))) {
      throw new Error("CR06_RESERVATION_NOT_EXPIRED");
    }
    const receipt = {
      receiptVersion: 1,
      preparationRunId: input.preparationRunId,
      transition: input.transition,
      actorId: input.actorId,
      asOf: asOf.toISOString(),
      idempotencyKey: input.idempotencyKey,
      reason: input.transition === "expired" ? "reservation_ttl_elapsed" : input.reason!.trim(),
      scopes: current.rows.map((row) => ({
        type: row.scope_type,
        identity: row.scope_identity,
        reservationKey: row.reservation_key,
        reservationReceiptHash: row.receipt_hash,
        expiresAt: new Date(row.expires_at).toISOString(),
      })),
    };
    const receiptHash = hashCr06(receipt);
    const updated = await client.query(
      `UPDATE cr06_preparation_reservations
          SET state=$2,reconciled_at=$3,reconciliation_receipt=$4::jsonb,
              reconciliation_receipt_hash=$5,reconciliation_actor_id=$6,
              reconciliation_as_of=$3,reconciliation_key=$7
        WHERE preparation_run_id=$1 AND state='held'
        RETURNING id`,
      [input.preparationRunId, input.transition, asOf, JSON.stringify(receipt),
        receiptHash, input.actorId, input.idempotencyKey],
    );
    if (updated.rowCount !== requiredScopes.length) {
      throw new Error("CR06_RESERVATION_RECONCILIATION_FENCE_FAILED");
    }
    await client.query("COMMIT");
    return {
      preparationRunId: input.preparationRunId,
      transition: input.transition,
      affectedScopes: updated.rowCount,
      receipt,
      receiptHash,
      replayed: false,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getCr06Catalog() {
  const [artifacts, artifactHistory, legacyCampaigns, legacySequences, packagePins] = await Promise.all([
    pool.query(`SELECT * FROM cr06_artifacts
      WHERE version=2 AND identity_key LIKE '%-v2'
      ORDER BY artifact_kind,identity_key`),
    pool.query(`SELECT * FROM cr06_artifacts
      WHERE NOT (version=2 AND identity_key LIKE '%-v2')
      ORDER BY version DESC,artifact_kind,identity_key`),
    pool.query(`SELECT id,name,status,created_by,created_at FROM campaigns ORDER BY id`),
    pool.query(`SELECT id,name,status,created_by,created_at,retired_at FROM follow_up_sequences ORDER BY id`),
    // Real package pins decide the label; ids are never hard-coded and status/name never decide it.
    pool.query(`SELECT campaign_id,sequence_id,lifecycle_state FROM sfp_campaign_package_versions`),
  ]);
  const { catalogClassForPins } = await import("./catalog-truth");
  const label = (kind: "campaign" | "sequence", row: { id: number; retired_at?: unknown }) => {
    const pins = packagePins.rows
      .filter((p: any) => (kind === "campaign" ? p.campaign_id : p.sequence_id) === row.id)
      .map((p: any) => p.lifecycle_state as string);
    return catalogClassForPins(pins, !!row.retired_at);
  };
  const compat = (c: ReturnType<typeof label>) =>
    c === "unresolved" ? "legacy_review_required"
      : c === "current" ? "current_sfp_package"
      : c === "template" ? "template_sfp_package"
      : "historical";
  return {
    governed: artifacts.rows,
    history: artifactHistory.rows,
    legacy: {
      campaigns: legacyCampaigns.rows.map((row) => { const catalogClass = label("campaign", row); return { ...row, catalogClass, compatibilityState: compat(catalogClass), approvalHistory: null }; }),
      sequences: legacySequences.rows.map((row) => { const catalogClass = label("sequence", row); return { ...row, catalogClass, compatibilityState: compat(catalogClass), approvalHistory: null }; }),
    },
  };
}

export async function getCr06Run(runId: string) {
  const [run, enrollments, intents] = await Promise.all([
    pool.query("SELECT * FROM cr06_preparation_runs WHERE id=$1", [runId]),
    pool.query("SELECT * FROM cr06_prepared_enrollments WHERE preparation_run_id=$1 ORDER BY cohort_ordinal", [runId]),
    pool.query("SELECT * FROM cr06_delivery_intents WHERE preparation_run_id=$1 ORDER BY scheduled_for,touch_number", [runId]),
  ]);
  if (!run.rows[0]) return null;
  return {
    ...run.rows[0],
    statusLabel: run.rows[0].state === "ready_held" ? "READY_HELD — SENDING OFF" : run.rows[0].state,
    enrollments: enrollments.rows,
    intents: intents.rows,
    providerAttemptCount: intents.rows.reduce((sum, row) => sum + Number(row.provider_attempt_count || 0), 0),
    dispatchAvailable: false,
  };
}

export function assertCr06DispatchUnavailable(): never {
  throw new Error("CR06_FINAL_DISPATCH_NOT_AUTHORIZED");
}