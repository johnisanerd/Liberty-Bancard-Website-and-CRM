#!/usr/bin/env npx tsx
/** In-process, transport-free regression checks for the isolated GHL runtime. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function main() {
  const oldProfile = process.env.BACKGROUND_JOB_PROFILE;
  const oldSfpProfile = process.env.SFP_RUNTIME_PROFILE;
  try {
    process.env.BACKGROUND_JOB_PROFILE = "ghl-sync-only";
    const {
      getBackgroundProfile,
      getQueuesForCapabilityGroups,
      getSelectiveGroups,
      getJobCapabilityGroup,
      isQueueSelectedByBackgroundProfile,
      WORKER_CAPABILITY_GROUPS,
    } = await import("../server/services/background-profile");
    const { getWorkerCapabilityStatus } = await import("../server/services/queue-manager");
    const { QUEUE_NAMES } = await import("../server/services/queue-names");
    const { autoAlignStages } = await import("../server/services/ghl-sync");
    const {
      getGhlSyncRuntimeSelectionStatus,
      isGhlSyncRuntimeOwnerFenceCurrent,
      isGhlSyncRuntimeSelectionValid,
    } = await import("../server/services/ghl-sync-runtime");

    assert.equal(getBackgroundProfile(), "ghl-sync-only");
    assert.deepEqual(getSelectiveGroups(), []);
    assert.equal(isQueueSelectedByBackgroundProfile(QUEUE_NAMES.GHL_SYNC), true);
    assert.equal(isQueueSelectedByBackgroundProfile(QUEUE_NAMES.GHL_ENROLLMENT_RECOVERY), false);
    assert.equal(isQueueSelectedByBackgroundProfile(QUEUE_NAMES.VOICEMAIL_SYNC), false);
    assert.equal(getWorkerCapabilityStatus(QUEUE_NAMES.GHL_SYNC).selected, true);
    assert.equal(getWorkerCapabilityStatus(QUEUE_NAMES.GHL_ENROLLMENT_RECOVERY).selected, false);
    assert.equal(getWorkerCapabilityStatus(QUEUE_NAMES.VOICEMAIL_SYNC).selected, false);

    const ghlQueues = getQueuesForCapabilityGroups(["ghl-integration"]);
    assert.deepEqual(ghlQueues, [QUEUE_NAMES.GHL_SYNC, QUEUE_NAMES.GHL_ENROLLMENT_RECOVERY, QUEUE_NAMES.VOICEMAIL_SYNC]);
    assert.deepEqual(WORKER_CAPABILITY_GROUPS["ghl-sync-only"], [QUEUE_NAMES.GHL_SYNC]);
    assert.deepEqual(getQueuesForCapabilityGroups(["ghl-sync-only"]), [QUEUE_NAMES.GHL_SYNC]);

    const expectedRuntime = "publish-build:stable-owner-test";
    const baseSelection = {
      controlEnabled: true,
      controlOwnerProfile: "ghl-sync-only",
      controlSelectedRuntime: expectedRuntime,
      expectedRuntime,
    };
    assert.equal(isGhlSyncRuntimeSelectionValid({
      ...baseSelection, globalProfile: "ghl-sync-only", selectiveGroups: [],
    }), true, "standalone isolated profile is selected");
    assert.equal(isGhlSyncRuntimeSelectionValid({
      ...baseSelection, globalProfile: "selective", selectiveGroups: ["enrichment", "ghl-sync-only"],
    }), true, "mixed selective profile retains unrelated groups and selects isolated GHL capability");
    assert.equal(isGhlSyncRuntimeSelectionValid({
      ...baseSelection, globalProfile: "selective", selectiveGroups: ["ghl-integration"],
    }), false, "legacy broader GHL group does not satisfy isolated runtime ownership");
    assert.equal(getGhlSyncRuntimeSelectionStatus({
      ...baseSelection, globalProfile: "full", selectiveGroups: [],
    }), "needs_isolated_group", "full-capable worker is not represented as healthy without isolated ownership");
    assert.equal(getGhlSyncRuntimeSelectionStatus({
      ...baseSelection, globalProfile: "selective", selectiveGroups: ["ghl-integration"],
    }), "needs_isolated_group", "legacy integration selection reports isolated group requirement");
    assert.equal(isGhlSyncRuntimeSelectionValid({
      ...baseSelection, globalProfile: "selective", selectiveGroups: ["ghl-sync-only"],
      controlSelectedRuntime: "publish-build:stale-owner",
    }), false, "stale selected-runtime identity is rejected");
    assert.equal(isGhlSyncRuntimeSelectionValid({
      ...baseSelection, globalProfile: "selective", selectiveGroups: ["ghl-sync-only"],
      ownerProfileEnv: "unexpected-owner",
    }), false, "mismatched optional owner-profile environment value is rejected");
    // The real environment string (not the normalized mode) must still select the isolated capability, and must not
    // widen anything: the broader integration group and a profile without the group stay unselected.
    const savedProfile = process.env.BACKGROUND_JOB_PROFILE;
    try {
      const { getGhlSyncSelectionProfileInputs } = await import("../server/services/ghl-sync-runtime");
      const statusFor = (raw: string) => {
        process.env.BACKGROUND_JOB_PROFILE = raw;
        return getGhlSyncRuntimeSelectionStatus({ ...baseSelection, ...getGhlSyncSelectionProfileInputs() });
      };
      assert.equal(statusFor("selective:enrichment,free-enrichment-lane,provider-live,ghl-sync-only"), "selected",
        "the deployed mixed profile string selects the isolated capability");
      assert.equal(statusFor("selective:enrichment,provider-live"), "needs_isolated_group", "a mixed profile without the group is not selected");
      assert.equal(statusFor("selective:enrichment,ghl-integration"), "needs_isolated_group", "the broader integration group is not selected");
      assert.equal(statusFor("ghl-sync-only"), "selected", "the standalone profile is selected");
      assert.equal(statusFor("off"), "needs_isolated_group", "off is not selected");
    } finally {
      if (savedProfile === undefined) delete process.env.BACKGROUND_JOB_PROFILE; else process.env.BACKGROUND_JOB_PROFILE = savedProfile;
    }
    const ownerFence = {
      profile: "ghl-sync-only",
      processProfile: "selective:enrichment,ghl-sync-only",
      releaseSha: "artifact-sha",
      deploymentIdentity: expectedRuntime,
      processIdentity: "owner-process",
      environment: "production",
      selectedRuntime: expectedRuntime,
      controlOwnerProfile: "ghl-sync-only",
      epoch: 7,
    };
    assert.equal(isGhlSyncRuntimeOwnerFenceCurrent(ownerFence, { ...ownerFence }), true);
    assert.equal(isGhlSyncRuntimeOwnerFenceCurrent(ownerFence, { ...ownerFence, epoch: 8 }), false,
      "stale control epoch cannot renew an existing durable owner");
    assert.equal(isGhlSyncRuntimeOwnerFenceCurrent(ownerFence, { ...ownerFence, processProfile: "full" }), false,
      "global profile identity remains separately fenced");

    process.env.BACKGROUND_JOB_PROFILE = "selective:enrichment,ghl-sync-only";
    assert.equal(getBackgroundProfile(), "selective");
    const mixedQueues = getQueuesForCapabilityGroups(getSelectiveGroups());
    assert.equal(mixedQueues.includes(QUEUE_NAMES.GHL_SYNC), true);
    assert.equal(mixedQueues.includes(QUEUE_NAMES.GHL_ENROLLMENT_RECOVERY), false);
    assert.equal(mixedQueues.includes(QUEUE_NAMES.VOICEMAIL_SYNC), false);
    assert.equal(getSelectiveGroups().includes("outreach" as any), false);
    assert.equal(getJobCapabilityGroup("enrichment", "campaign-queue-run"), "outreach",
      "selecting enrichment does not imply the co-located outreach job");
    assert.equal(getJobCapabilityGroup("enrichment", "inbound-confirmation-followup"), "ghl-integration",
      "narrow GHL CRM selection does not imply the GHL communication follow-up job");
    assert.equal(isQueueSelectedByBackgroundProfile(QUEUE_NAMES.GHL_SYNC), true);
    assert.equal(isQueueSelectedByBackgroundProfile(QUEUE_NAMES.GHL_ENROLLMENT_RECOVERY), false);
    assert.equal(getWorkerCapabilityStatus(QUEUE_NAMES.GHL_SYNC).selected, true);
    assert.equal(getWorkerCapabilityStatus(QUEUE_NAMES.GHL_ENROLLMENT_RECOVERY).selected, false);

    // A matching provider stage title is deliberately not a mapping.
    assert.deepEqual(
      autoAlignStages(["New Lead"], [{ name: "New Lead", id: "fresh-provider-uuid" }])[0],
      { localName: "New Lead", ghlId: null, ghlName: null, score: 0, method: "none" },
    );

    const runtimeSource = await readFile(new URL("../server/services/ghl-sync-runtime.ts", import.meta.url), "utf8");
    assert.match(runtimeSource, /OWNER_SETTING_KEY = "ghl_sync_runtime_owner"/);
    assert.doesNotMatch(runtimeSource, /sfp_runtime_owner|sfp_runtime_lease|sfpRedis/);
    const syncSource = await readFile(new URL("../server/services/ghl-sync.ts", import.meta.url), "utf8");
    assert.match(syncSource, /ghl_semantic_stage_id_map/);
    assert.doesNotMatch(syncSource, /getSystemSetting\("ghl_stage_id_map"\)|GHL_STAGE_ID_MAP/);
    const controlSource = await readFile(new URL("../server/services/ghl-sync-control.ts", import.meta.url), "utf8");
    assert.match(controlSource, /resolveRoutineSfpDeploymentIdentity/);
    assert.match(runtimeSource, /resolveRoutineSfpDeploymentIdentity/);
    assert.match(runtimeSource, /needs_isolated_group/);
    const controlMutation = controlSource.slice(
      controlSource.indexOf("export async function patchGhlSyncControl"),
      controlSource.indexOf("export async function recordGhlNativeReview"),
    );
    assert.doesNotMatch(controlMutation, /sfp|outboundPause|providerBudget|SFP_RUNTIME/i);
    assert.equal(process.env.SFP_RUNTIME_PROFILE, oldSfpProfile);

    console.log("PASS: GHL runtime remains queue/profile isolated; no title-derived stage mapping or SFP selector mutation.");
  } finally {
    if (oldProfile === undefined) delete process.env.BACKGROUND_JOB_PROFILE;
    else process.env.BACKGROUND_JOB_PROFILE = oldProfile;
    if (oldSfpProfile === undefined) delete process.env.SFP_RUNTIME_PROFILE;
    else process.env.SFP_RUNTIME_PROFILE = oldSfpProfile;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});