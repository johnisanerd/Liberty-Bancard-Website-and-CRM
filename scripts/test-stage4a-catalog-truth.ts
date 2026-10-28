/** Stage 4A F02: derived catalog contract. Pure derivation over fixtures plus one read-only dev read. */
import assert from "node:assert/strict";
import { buildCatalogTruth, catalogClassForPins, loadCatalogTruth, type CatalogInput } from "../server/services/catalog-truth";

let n = 0;
const ok = (m: string) => { n++; console.log(`  ✅ ${m}`); };

// Fixture ids are deliberately NOT 82-86 / 1153-1157: pins are resolved from the rows, never from known ids.
const input = (over: Partial<CatalogInput> = {}): CatalogInput => ({
  packages: [
    { id: "p1", packageKey: "sfp.automotive.v2", vertical: "Automotive", campaignId: 901, sequenceId: 2001, lifecycleState: "current" },
    { id: "p2", packageKey: "sfp.healthcare.v2", vertical: "Healthcare", campaignId: 902, sequenceId: 2002, lifecycleState: "draft" },
    { id: "p3", packageKey: "sfp.restaurant.v1", vertical: "Restaurant", campaignId: 903, sequenceId: 2003, lifecycleState: "superseded" },
  ],
  campaigns: [
    { id: 901, name: "anything", status: "draft", retiredAt: null, approvedRevision: 2, contentRevision: 2 },
    { id: 902, name: "SFP-V2 draft", status: "draft", retiredAt: null, approvedRevision: null, contentRevision: 1 },
    { id: 903, name: "old", status: "active", retiredAt: null, approvedRevision: 1, contentRevision: 1 },
    { id: 904, name: "orphan", status: "active", retiredAt: null, approvedRevision: null, contentRevision: 1 },
  ],
  sequences: [
    { id: 2001, name: "x", status: "paused", retiredAt: null, stepCount: 3 },
    { id: 2002, name: "y", status: "paused", retiredAt: null, stepCount: 3 },
    { id: 2003, name: "z", status: "paused", retiredAt: "2026-01-01T00:00:00.000Z", stepCount: 3 },
    { id: 2004, name: "SFP Cold Outreach (current)", status: "active", retiredAt: null, stepCount: 1 },
    { id: 2005, name: "retired-no-package", status: "paused", retiredAt: "2026-01-01T00:00:00.000Z", stepCount: 0 },
  ],
  plannedPackageKeys: ["sfp.automotive.v2", "sfp.healthcare.v2", "sfp.restaurant.v1", "sfp.dental.v1"],
  cr06GovernedArtifacts: 0,
  globalPauseState: "paused",
  statusActiveSequences: 1,
  asOf: "2026-10-28T00:00:00.000Z",
  ...over,
});

async function main() {
  const t = buildCatalogTruth(input());
  const cls = (list: { id: number; catalogClass: string }[], id: number) => list.find((a) => a.id === id)!.catalogClass;
  assert.equal(cls(t.campaigns, 901), "current");
  assert.equal(cls(t.sequences, 2001), "current");
  assert.equal(cls(t.campaigns, 902), "template");
  assert.equal(cls(t.campaigns, 903), "historical");
  assert.equal(cls(t.sequences, 2003), "historical");
  ok("current / template / historical derive from package lifecycle pins");

  assert.equal(cls(t.campaigns, 904), "unresolved");
  assert.equal(cls(t.sequences, 2004), "unresolved", "an unpinned status='active' sequence stays unresolved; name and status never decide");
  assert.equal(cls(t.sequences, 2005), "historical", "retired_at derives retirement");
  ok("unowned assets are unresolved; retirement comes from retired_at; name/status never decide");

  assert.deepEqual(t.uninstalledPackageKeys, ["sfp.dental.v1"]);
  assert.equal(t.counts!.uninstalled, 1);
  ok("planned package with no installed row is uninstalled");

  assert.equal(t.packages.filter((p) => p.lifecycleState === "superseded").length, 1);
  ok("superseded package versions are preserved in the catalog");

  assert.equal(catalogClassForPins(["current"], true), "unresolved");
  assert.equal(t.cr06.state, "empty");
  assert.equal(cls(t.campaigns, 901), "current", "empty CR-06 must not make verified current SFP legacy");
  ok("empty CR-06 does not relabel current SFP as legacy");

  const cur = t.packages.find((p) => p.packageKey === "sfp.automotive.v2")!;
  assert.equal(cur.readiness.configured.state, "yes");
  assert.equal(cur.readiness.selected.state, "yes");
  assert.equal(cur.readiness.qualified.state, "yes");
  assert.equal(cur.readiness.paused.state, "yes");
  assert.equal(cur.readiness.operating.state, "no");
  assert.equal(cur.readiness.nativeEffectVerified.state, "unavailable");
  assert.equal(t.cro07.productionConnected, false);
  ok("readiness states: configured/selected/qualified/paused true; operating no; native effect unavailable (CRO-07 scoped)");

  const draft = t.packages.find((p) => p.packageKey === "sfp.healthcare.v2")!;
  assert.equal(draft.readiness.selected.state, "no");
  assert.equal(draft.readiness.qualified.state, "no");
  ok("draft template is not selected or qualified");

  const active = buildCatalogTruth(input({ globalPauseState: "unpaused", sequences: input().sequences.map((s) => (s.id === 2001 ? { ...s, status: "active" } : s)), campaigns: input().campaigns.map((c) => (c.id === 901 ? { ...c, status: "active" } : c)) }));
  assert.equal(active.packages.find((p) => p.packageKey === "sfp.automotive.v2")!.readiness.operating.state, "yes");
  const unk = buildCatalogTruth(input({ globalPauseState: "unavailable" }));
  assert.equal(unk.packages.find((p) => p.packageKey === "sfp.automotive.v2")!.readiness.operating.state, "unavailable");
  ok("operating needs unpaused + active; unreadable pause state is unavailable, not no");

  const missing = buildCatalogTruth(input({ sequences: input().sequences.filter((s) => s.id !== 2001) }));
  const mp = missing.packages.find((p) => p.packageKey === "sfp.automotive.v2")!;
  assert.equal(mp.pinsResolved, false);
  assert.equal(mp.readiness.configured.state, "no");
  ok("a pin that no longer resolves is configured:no");

  const conflict = buildCatalogTruth(input({ sequences: input().sequences.map((s) => (s.id === 2001 ? { ...s, retiredAt: "2026-02-01T00:00:00.000Z" } : s)) }));
  assert.equal(cls(conflict.sequences, 2001), "unresolved");
  ok("current pin onto a retired sequence is flagged unresolved");

  const dup = buildCatalogTruth(input({ packages: [...input().packages, { id: "p9", packageKey: "sfp.automotive.v2", vertical: "Automotive", campaignId: 901, sequenceId: 2001, lifecycleState: "current" }] }));
  assert.equal(dup.packages[0].readiness.selected.state, "no");
  ok("two current versions for one vertical are not selected");

  assert.equal(t.statusActiveSequences.count, 1);
  assert.match(t.statusActiveSequences.note, /not readiness proof/);
  ok("status='active' count is labelled as not readiness proof");

  // Live read-only dev read: never throws; an unreadable DB is reported unavailable, not an empty catalog.
  const live = await loadCatalogTruth();
  if (live.available) { assert.ok(Array.isArray(live.packages)); assert.ok(live.counts); }
  else { assert.equal(live.counts, null); assert.ok(live.unavailableReason); }
  ok(`loadCatalogTruth ${live.available ? "read" : "reported unavailable"} (${live.packages.length} package versions in this environment)`);

  console.log(`\n${n} check groups passed`);
  process.exit(0);
}
main().catch((e) => { console.error("FAIL", e); process.exit(1); });
