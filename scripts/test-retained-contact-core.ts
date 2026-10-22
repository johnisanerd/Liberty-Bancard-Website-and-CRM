import assert from "node:assert/strict";
import { RetainedContactCore } from "../client/src/lib/retained-contact-core";

let checks = 0;
const check = (ok: unknown, label: string) => { assert.ok(ok, label); checks++; console.log(`✓ ${label}`); };
const actorA = { id: "a", epoch: 1, permissions: 1 };
const keyA7 = RetainedContactCore.key(actorA, 7);
const core = (name: string) => ({ contact: { name }, capabilities: {} });

{
  const s = new RetainedContactCore<ReturnType<typeof core>>();
  check(s.read(keyA7) === null, "Nothing is retained before the first authorized read");
  s.observe(keyA7, { data: core("Ada"), hasCore: true });
  check(s.read(keyA7)?.contact.name === "Ada", "An authorized read is retained for the same actor and contact");
  s.observe(keyA7, { data: undefined, hasCore: false });
  check(s.read(keyA7)?.contact.name === "Ada", "A section load for the same actor and contact keeps the header");
}
{
  const s = new RetainedContactCore<ReturnType<typeof core>>();
  s.observe(keyA7, { data: core("Ada"), hasCore: true });
  const keyA8 = RetainedContactCore.key(actorA, 8);
  s.observe(keyA8, { data: undefined, hasCore: false });
  check(s.read(keyA8) === null && s.read(keyA7) === null, "Another record shows no retained header, and the old one is dropped");
  s.observe(keyA7, { data: undefined, hasCore: false });
  check(s.read(keyA7) === null, "Returning to the first record does not resurrect the dropped header");
}
{
  const s = new RetainedContactCore<ReturnType<typeof core>>();
  s.observe(keyA7, { data: core("Ada"), hasCore: true });
  const other = RetainedContactCore.key({ ...actorA, id: "b" }, 7);
  s.observe(other, { data: undefined, hasCore: false });
  check(s.read(other) === null, "A different actor never sees another actor's retained header");
}
{
  const s = new RetainedContactCore<ReturnType<typeof core>>();
  s.observe(keyA7, { data: core("Ada"), hasCore: true });
  const changed = RetainedContactCore.key({ ...actorA, permissions: 2 }, 7);
  s.observe(changed, { data: undefined, hasCore: false });
  check(s.read(changed) === null, "A changed permission generation drops the retained header");
}
{
  const s = new RetainedContactCore<ReturnType<typeof core>>();
  s.observe(keyA7, { data: core("Ada"), hasCore: true });
  s.observe(keyA7, { data: undefined, hasCore: false, error: new Error("403") });
  check(s.read(keyA7) === null, "A denied or failed read drops the retained header");
  s.observe(keyA7, { data: undefined, hasCore: false });
  check(s.read(keyA7) === null, "A later load after an error shows no stale header");
}
{
  // A late answer for the previous record is never passed to observe for the current key, because the read is keyed;
  // simulate the only way it could matter: the current key has no data yet while an old answer exists elsewhere.
  const s = new RetainedContactCore<ReturnType<typeof core>>();
  s.observe(keyA7, { data: core("Ada"), hasCore: true });
  const keyA8 = RetainedContactCore.key(actorA, 8);
  s.observe(keyA8, { data: undefined, hasCore: false });
  s.observe(keyA8, { data: core("Grace"), hasCore: true });
  check(s.read(keyA8)?.contact.name === "Grace" && s.read(keyA7) === null, "Only the current record's answer becomes the header");
}
console.log(`PASS retained Contact core: ${checks} checks`);
