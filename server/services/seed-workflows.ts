import { storage } from "../storage";
import { applyReviewedCopyReplacements } from "./reviewed-copy-replacements";
import workflowsData from "../data/seeds/workflows.json";

const PREBUILT_WORKFLOWS = (workflowsData as any).PREBUILT_WORKFLOWS as any[];
const DEFAULT_SLA_CONFIGS = (workflowsData as any).DEFAULT_SLA_CONFIGS as any[];
const DEFAULT_MESSAGE_TEMPLATES = (workflowsData as any).DEFAULT_MESSAGE_TEMPLATES as any[];
const DEFAULT_COLLATERAL_PACKETS = (workflowsData as any).DEFAULT_COLLATERAL_PACKETS as any[];
const PILLAR_SDR_CAMPAIGNS = (workflowsData as any).PILLAR_SDR_CAMPAIGNS as Array<{ campaign: any; steps: any[] }>;

export async function seedDefaultData() {
  try {
    const existingWorkflows = await storage.getWorkflows();
    const existingNames = new Set(existingWorkflows.map(w => w.name));
    const newWorkflows = PREBUILT_WORKFLOWS.filter(wf => !existingNames.has(wf.name));
    if (newWorkflows.length > 0) {
      console.log(`Seeding ${newWorkflows.length} pre-built workflows...`);
      for (const wf of newWorkflows) {
        await storage.createWorkflow(wf);
      }
      console.log(`Seeded ${newWorkflows.length} workflows`);
    }

    const WORKFLOWS_TO_UPDATE: Record<string, { actions: any[] }> = {
      "F. Closed Won - Onboarding Kickoff": {
        actions: PREBUILT_WORKFLOWS.find(w => w.name === "F. Closed Won - Onboarding Kickoff")!.actions,
      },
      "G. Go-Live Lifecycle (Day 2/7/14/30)": {
        actions: PREBUILT_WORKFLOWS.find(w => w.name === "G. Go-Live Lifecycle (Day 2/7/14/30)")!.actions,
      },
    };

    for (const [name, updates] of Object.entries(WORKFLOWS_TO_UPDATE)) {
      const existing = existingWorkflows.find(w => w.name === name);
      if (existing) {
        const existingActions = JSON.stringify(existing.actions);
        const newActions = JSON.stringify(updates.actions);
        if (existingActions !== newActions) {
          if (!existing.retiredAt) await storage.updateWorkflow(existing.id, { actions: updates.actions }, { expectedVersion: existing.version });
          console.log(`[Seed] Updated workflow "${name}" with new actions`);
        }
      }
    }

    // Owner-approved wording replacements (docs/public-journeys/copy-reconciliation.md). Exact-substring edits only;
    // never toggles a workflow or template.
    const copy = await applyReviewedCopyReplacements();
    if (copy.workflows.length || copy.templates.length || copy.skipped.length) {
      console.log(`[Seed] Reviewed copy replacements: workflows=${copy.workflows.length} templates=${copy.templates.length} skipped=${copy.skipped.length}`);
    }

    const existingSlaConfigs = await storage.getSlaConfigs();
    if (existingSlaConfigs.length === 0) {
      console.log("Seeding SLA configurations...");
      for (const config of DEFAULT_SLA_CONFIGS) {
        await storage.createSlaConfig(config);
      }
      console.log(`Seeded ${DEFAULT_SLA_CONFIGS.length} SLA configs`);
    }

    const existingTemplates = await storage.getMessageTemplates();
    if (existingTemplates.length === 0) {
      console.log("Seeding message templates...");
      for (const template of DEFAULT_MESSAGE_TEMPLATES) {
        await storage.createMessageTemplate(template);
      }
      console.log(`Seeded ${DEFAULT_MESSAGE_TEMPLATES.length} message templates`);
    }

    const existingPackets = await storage.getCollateralPackets();
    const existingPacketNames = new Set(existingPackets.map(p => p.name));
    const newPackets = DEFAULT_COLLATERAL_PACKETS.filter(p => !existingPacketNames.has(p.name));
    if (newPackets.length > 0) {
      console.log(`Seeding ${newPackets.length} collateral packets...`);
      for (const packet of newPackets) {
        await storage.createCollateralPacket(packet);
      }
      console.log(`Seeded ${newPackets.length} collateral packets`);
    }

    const existingCampaigns = await storage.getCampaigns();
    const existingCampaignNames = new Set(existingCampaigns.map(c => c.name));
    const newCampaigns = PILLAR_SDR_CAMPAIGNS.filter(c => !existingCampaignNames.has(c.campaign.name));
    if (newCampaigns.length > 0) {
      console.log(`Seeding ${newCampaigns.length} pillar SDR campaigns...`);
      for (const { campaign, steps } of newCampaigns) {
        const created = await storage.createCampaign(campaign as any);
        for (const step of steps) {
          await storage.createCampaignStep({ ...step, campaignId: created.id } as any);
        }
      }
      console.log(`Seeded ${newCampaigns.length} SDR campaigns with steps`);
    }
  } catch (err) {
    console.error("Seed error:", err);
  }
}
