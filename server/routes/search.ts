import type { Express } from "express";
import { isAuthenticated, isDashboardUser, requireRole } from "../replit_integrations/auth";
import { storage } from "../storage";
import { contacts } from "@shared/schema";
import { serverError } from "../utils/server-error";

export function registerSearchRoutes(app: Express) {
  // === UNIVERSAL SMART SEARCH ===
  app.get("/api/search", isDashboardUser, async (req, res) => {
    try {
      const q = (req.query.q as string || "").toLowerCase().trim();
      if (!q || q.length < 2) return res.json({ results: [] });

      const user = req.user as any;
      const role = user?.role;
      const isPrivileged = role === "admin" || role === "manager";
      const canSearchProspects = isPrivileged;
      // Agents get object-level filtering on every entity type; prospects have no
      // per-agent ownership model so they're excluded from agent search entirely (#2021).
      const [contactsResult, dealsResult, ticketsResult, tasks, prospectsResult] = await Promise.all([
        storage.getContacts({ limit: 500 }),
        storage.getDeals({ limit: 500 }),
        storage.getTickets({ limit: 500 }),
        storage.getTasks(),
        canSearchProspects ? storage.getProspects(undefined, { limit: 500 }) : Promise.resolve({ data: [] }),
      ]);
      let contacts = contactsResult.data;
      let deals = dealsResult.data;
      let tickets = ticketsResult.data;
      let allTasks: any[] = tasks;
      const prospects = prospectsResult.data;

      if (!isPrivileged && role === "agent") {
        const email = user?.email;
        contacts = contacts.filter(c => c.assignedTo === email || c.assignedTo == null);
        deals = deals.filter(d => !d.archivedAt && d.owner === email);
        const contactMap = new Map(contacts.map(c => [c.id, c]));
        tickets = tickets.filter(t => t.contactId != null && contactMap.has(t.contactId));
        allTasks = allTasks.filter((t: any) => {
          if (t.contactId) return contactMap.has(t.contactId);
          if (t.dealId) return deals.some(d => d.id === t.dealId);
          return false;
        });
      } else if (!isPrivileged) {
        // Unknown/other staff roles get no CRM object visibility from search.
        contacts = []; deals = []; tickets = []; allTasks = [];
      }

      const results: Array<{ type: string; id: number; title: string; subtitle: string; href: string }> = [];

      contacts.forEach(c => {
        const searchStr = `${c.firstName} ${c.lastName} ${c.email} ${c.companyName || ""} ${c.phone || ""}`.toLowerCase();
        if (searchStr.includes(q)) results.push({ type: "contact", id: c.id, title: `${c.firstName} ${c.lastName}`, subtitle: c.companyName || c.email || c.phone || "", href: "/dashboard/contacts" });
      });

      deals.forEach(d => {
        const searchStr = `${d.offerPath || ""} ${d.stage} ${d.pipeline} deal #${d.id}`.toLowerCase();
        if (searchStr.includes(q)) results.push({ type: "deal", id: d.id, title: `Deal #${d.id}`, subtitle: `${d.stage} - ${d.offerPath || d.pipeline}`, href: "/dashboard/pipeline" });
      });

      tickets.forEach(t => {
        const searchStr = `${t.subject} ${t.category || ""} ${t.status}`.toLowerCase();
        if (searchStr.includes(q)) results.push({ type: "ticket", id: t.id, title: t.subject, subtitle: `${t.status} - ${t.category || "General"}`, href: "/dashboard/tickets" });
      });

      allTasks.forEach((t: any) => {
        const searchStr = `${t.title} ${t.description || ""} ${t.status}`.toLowerCase();
        if (searchStr.includes(q)) results.push({ type: "task", id: t.id, title: t.title, subtitle: t.status || "pending", href: "/dashboard/tasks" });
      });

      prospects.forEach(p => {
        const searchStr = `${p.companyName || ""} ${p.ownerFirstName || ""} ${p.ownerLastName || ""} ${p.email || ""} ${p.vertical || ""}`.toLowerCase();
        if (searchStr.includes(q)) results.push({ type: "prospect", id: p.id, title: p.companyName || "Unknown", subtitle: `${p.vertical || "Unknown"} - ${p.score || "unscored"}`, href: "/dashboard/prospects" });
      });

      res.json({ results: results.slice(0, 20) });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === ADVANCED SEARCH ===
  app.get("/api/search/advanced", isDashboardUser, async (req, res) => {
    const { q, dateFrom, dateTo, assignedTo, entityType, tags } = req.query;
    const query = String(q || '').toLowerCase().trim();
    const results: any = { contacts: [], deals: [], tickets: [], tasks: [] };

    const user = req.user as any;
    const role = user?.role;
    const isPrivileged = role === "admin" || role === "manager";
    // An agent can never widen scope past their own email via the assignedTo
    // query param — object-level ownership is enforced server-side (#2021).
    const effectiveAssignedTo = role === "agent" ? user?.email : (assignedTo ? String(assignedTo) : undefined);
    const agentBlocked = !isPrivileged && role !== "agent";

    // Ownership sets are derived independently of query/entityType/pagination so
    // agent visibility never depends on what a search happens to match (#2021).
    let ownedContactIds: Set<number> | null = null; // null = unrestricted (privileged)
    let ownedDealIds: Set<number> | null = null;
    if (role === "agent") {
      const [{ data: ownedContacts }, { data: ownedDeals }] = await Promise.all([
        storage.getContacts({ limit: 5000 }),
        storage.getDeals({ limit: 5000 }),
      ]);
      ownedContactIds = new Set(
        ownedContacts.filter(c => c.assignedTo === user?.email).map(c => c.id)
      );
      ownedDealIds = new Set(
        ownedDeals.filter(d => !d.archivedAt && d.owner === user?.email).map(d => d.id)
      );
    }

    if (!agentBlocked && (!entityType || entityType === 'contact')) {
      const { data: allContacts } = await storage.getContacts({ limit: 500 });
      results.contacts = allContacts.filter(c => {
        if (ownedContactIds && !ownedContactIds.has(c.id)) return false;
        if (query && !`${c.firstName} ${c.lastName} ${c.email} ${c.companyName || ''}`.toLowerCase().includes(query)) return false;
        if (dateFrom && new Date(c.createdAt!) < new Date(String(dateFrom))) return false;
        if (dateTo && new Date(c.createdAt!) > new Date(String(dateTo))) return false;
        if (tags) {
          const tagList = String(tags).split(',');
          if (!c.tags?.some(t => tagList.includes(t))) return false;
        }
        return true;
      }).slice(0, 50);
    }

    if (!agentBlocked && (!entityType || entityType === 'deal')) {
      const { data: allDeals } = await storage.getDeals({ limit: 500 });
      results.deals = allDeals.filter(d => {
        if (d.archivedAt) return false;
        if (ownedDealIds && !ownedDealIds.has(d.id)) return false;
        if (query && !`${d.stage} ${d.pipeline} ${d.notes || ''} ${d.owner || ''}`.toLowerCase().includes(query)) return false;
        if (effectiveAssignedTo && d.owner !== effectiveAssignedTo) return false;
        if (dateFrom && new Date(d.createdAt!) < new Date(String(dateFrom))) return false;
        if (dateTo && new Date(d.createdAt!) > new Date(String(dateTo))) return false;
        return true;
      }).slice(0, 50);
    }

    if (!agentBlocked && (!entityType || entityType === 'ticket')) {
      const { data: allTickets } = await storage.getTickets({ limit: 500 });
      results.tickets = allTickets.filter(t => {
        if (ownedContactIds && !(t.contactId != null && ownedContactIds.has(t.contactId))) return false;
        if (query && !`${t.subject} ${t.description} ${t.category || ''}`.toLowerCase().includes(query)) return false;
        if (effectiveAssignedTo && t.assignedTo !== effectiveAssignedTo) return false;
        if (dateFrom && new Date(t.createdAt!) < new Date(String(dateFrom))) return false;
        if (dateTo && new Date(t.createdAt!) > new Date(String(dateTo))) return false;
        return true;
      }).slice(0, 50);
    }

    if (!agentBlocked && (!entityType || entityType === 'task')) {
      const allTasks = await storage.getTasks();
      results.tasks = allTasks.filter((t: any) => {
        if (ownedContactIds && ownedDealIds) {
          const linkedToOwnedContact = t.contactId != null && ownedContactIds.has(t.contactId);
          const linkedToOwnedDeal = t.dealId != null && ownedDealIds.has(t.dealId);
          if (!linkedToOwnedContact && !linkedToOwnedDeal) return false;
        }
        if (query && !`${t.title} ${t.description || ''}`.toLowerCase().includes(query)) return false;
        if (effectiveAssignedTo && t.assignedTo !== effectiveAssignedTo) return false;
        if (dateFrom && new Date(t.createdAt!) < new Date(String(dateFrom))) return false;
        if (dateTo && new Date(t.createdAt!) > new Date(String(dateTo))) return false;
        return true;
      }).slice(0, 50);
    }

    res.json(results);
  });


  // === AUTO-LEAD ROUTING ===
  // Prospects have no per-agent ownership model — match the admin/manager gate
  // used by /api/prospects and /api/prospects/:id (#2021).
  app.post("/api/ai/route-prospect", isAuthenticated, requireRole("admin", "manager"), async (req, res) => {
    try {
      const { prospectId } = req.body;
      if (!prospectId) return res.status(400).json({ message: "prospectId required" });

      const prospect = await storage.getProspect(Number(prospectId));
      if (!prospect) return res.status(404).json({ message: "Prospect not found" });

      const campaigns = await storage.getCampaigns();
      const activeCampaigns = campaigns.filter(c => c.name.startsWith("SDR-"));

      let bestCampaign = activeCampaigns[0];
      const vert = (prospect.vertical || "").toLowerCase();

      for (const camp of activeCampaigns) {
        const campVerticals = (camp.targetVerticals || []).join(" ").toLowerCase();
        const campName = camp.name.toLowerCase();
        if (campVerticals.includes(vert) || campName.includes(vert)) {
          bestCampaign = camp;
          break;
        }
        if (vert.includes("restaurant") && campName.includes("restaurant")) { bestCampaign = camp; break; }
        if ((vert.includes("medical") || vert.includes("dental") || vert.includes("healthcare")) && campName.includes("medical")) { bestCampaign = camp; break; }
        if ((vert.includes("retail") || vert.includes("ecommerce")) && campName.includes("retail")) { bestCampaign = camp; break; }
        if ((vert.includes("salon") || vert.includes("spa") || vert.includes("beauty")) && campName.includes("salon")) { bestCampaign = camp; break; }
        if ((vert.includes("auto") || vert.includes("trades")) && campName.includes("auto")) { bestCampaign = camp; break; }
        if ((vert.includes("professional") || vert.includes("legal") || vert.includes("accounting")) && campName.includes("professional")) { bestCampaign = camp; break; }
      }

      if (!bestCampaign) {
        bestCampaign = activeCampaigns.find(c => c.name.includes("Statement Review")) || activeCampaigns[0];
      }

      await storage.updateProspect(Number(prospectId), { status: "campaign_assigned" });

      res.json({ campaignId: bestCampaign?.id, campaignName: bestCampaign?.name, prospectId: prospect.id });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/ai/route-prospects-bulk", isAuthenticated, requireRole("admin", "manager"), async (req, res) => {
    try {
      let { prospectIds } = req.body;
      if (prospectIds !== undefined && !Array.isArray(prospectIds)) {
        return res.status(400).json({ message: "prospectIds must be an array" });
      }

      // Auto-select a batch of unrouted prospects when no explicit selection is
      // provided (e.g. the AI Command Center "Run Now" button has no selection UI).
      if (!prospectIds || prospectIds.length === 0) {
        const rawProspects = await storage.getProspectsByStatus("raw");
        prospectIds = rawProspects.slice(0, 50).map(p => p.id);

        if (prospectIds.length === 0) {
          await storage.createAuditLog({
            action: "prospect_routed",
            entityType: "system",
            entityId: 0,
            details: {
              routed: 0,
              requested: 0,
              actorId: (req as any).user?.id,
              resultState: "no_op_with_reason",
              reason: "No unrouted prospects found to route.",
            },
          }).catch((err: any) => console.error("[AI] Failed to write prospect_routed audit log:", err.message));
          return res.json({ routed: 0, results: [], reason: "No unrouted prospects found to route." });
        }
      }

      const campaigns = await storage.getCampaigns();
      const sdrCampaigns = campaigns.filter(c => c.name.startsWith("SDR-"));
      const results: Array<{ prospectId: number; campaignId: number; campaignName: string }> = [];

      for (const pid of prospectIds.slice(0, 100)) {
        const prospect = await storage.getProspect(Number(pid));
        if (!prospect) continue;

        const vert = (prospect.vertical || "").toLowerCase();
        let matched = sdrCampaigns.find(c => {
          const name = c.name.toLowerCase();
          const verts = (c.targetVerticals || []).join(" ").toLowerCase();
          return verts.includes(vert) || name.includes(vert);
        });
        if (!matched) matched = sdrCampaigns.find(c => c.name.includes("Statement Review")) || sdrCampaigns[0];

        if (matched) {
          await storage.updateProspect(Number(pid), { status: "campaign_assigned" });
          results.push({ prospectId: prospect.id, campaignId: matched.id, campaignName: matched.name });
        }
      }

      const noOpReason = results.length === 0
        ? (sdrCampaigns.length === 0
          ? "No active SDR campaigns exist to route prospects into."
          : "None of the provided prospect IDs matched a valid, routable prospect.")
        : undefined;

      await storage.createAuditLog({
        action: "prospect_routed",
        entityType: "system",
        entityId: 0,
        details: {
          routed: results.length,
          requested: prospectIds.length,
          actorId: (req as any).user?.id,
          resultState: results.length > 0 ? (results.length < prospectIds.length ? "partial_success" : "success") : "no_op_with_reason",
          reason: noOpReason,
        },
      }).catch((err: any) => console.error("[AI] Failed to write prospect_routed audit log:", err.message));

      res.json({ routed: results.length, results, reason: noOpReason });
    } catch (err: any) {
      serverError(res, err);
    }
  });

}
