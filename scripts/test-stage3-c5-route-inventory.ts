import assert from "node:assert/strict";
import fs from "node:fs";
import express from "express";
import { extractRouteInventory, instrumentExpressRouting, mountCovers } from "../server/services/express-route-provenance";

// C5-R01: registration-bound permissions inventory on the installed Express 5 (no DB, no provider, no server).
instrumentExpressRouting();
instrumentExpressRouting(); // idempotent

type Tagged = express.RequestHandler & { _requiredRoles: readonly string[] };
const tag = (roles: string[]): Tagged => Object.assign(((_q, _s, next) => next()) as express.RequestHandler, { _requiredRoles: roles });
const admin = tag(["admin"]);
const staff = tag(["admin", "manager", "agent"]);
const managerOnly = tag(["manager"]);
const signedIn = tag(["any-authenticated"]);
const explicitPublic = tag(["public"]);
const noop: express.RequestHandler = (_q, s) => void s.end();

const app = express();
assert.equal((app as unknown as { _router?: unknown })._router, undefined, "Express 5 has no app._router (the legacy extractor read it)");

const nested = express.Router();
nested.get("/deep/:id", noop);
nested.post("/deep/:id", admin, noop);
const outer = express.Router();
outer.use("/inner", nested);
outer.get("/status", noop);
app.use("/api/admin", admin);
app.use("/api/admin", outer);
const dashboard = express.Router();
dashboard.use(staff);
dashboard.route("/items").get(noop).post(noop);
app.use("/api/work", dashboard);
const both = express.Router();
both.get("/x", managerOnly, noop);
app.use("/api/both", staff, both);
app.get("/api/me", signedIn, noop);
app.get("/api/open", explicitPublic, noop);
app.get("/api/inline-auth", noop); // untagged: handler may check inline
app.get(["/api/alpha", "/api/beta"], noop);
app.use("/api/late", (_q, _s, next) => next());

// Synthetic false-method flag (robustness, not a claim about a production route).
const weird = express.Router();
const route = weird.route("/weird");
route.get(noop);
(route as unknown as { methods: Record<string, boolean> }).methods.post = false;
app.use("/api/weird", weird);

const inv = extractRouteInventory(app);
assert.equal(inv.status, "ok");
const find = (method: string, path: string) => inv.routes.find(r => r.method === method && r.path === path);

// Full mount paths survive nesting.
assert.ok(find("GET", "/api/admin/inner/deep/:id"), "nested mount path composed");
assert.ok(find("GET", "/api/admin/status"), "single mount path composed");
// Inherited ordered guard provenance.
assert.equal(find("GET", "/api/admin/inner/deep/:id")!.access, "role");
assert.deepEqual(find("GET", "/api/admin/inner/deep/:id")!.roles, ["admin"]);
assert.equal(find("GET", "/api/admin/inner/deep/:id")!.guards[0].source, "mount");
assert.equal(find("GET", "/api/admin/inner/deep/:id")!.guards[0].mountPath, "/api/admin");
assert.equal(find("POST", "/api/admin/inner/deep/:id")!.guards.length, 2, "mount guard and route guard both recorded");
// Router-level guard applies to every method on its routes.
assert.deepEqual(find("GET", "/api/work/items")!.roles, ["admin", "manager", "agent"]);
assert.deepEqual(find("POST", "/api/work/items")!.roles, ["admin", "manager", "agent"]);
// Conjunction, not "last tagged handler wins".
assert.deepEqual(find("GET", "/api/both/x")!.roles, ["manager"]);
assert.equal(find("GET", "/api/both/x")!.guards.length, 2);
// Explicitly public vs signed-in vs unknown.
assert.equal(find("GET", "/api/me")!.access, "authenticated");
assert.equal(find("GET", "/api/open")!.access, "public");
assert.equal(find("GET", "/api/inline-auth")!.access, "unknown", "untagged is unknown, never public");
assert.notEqual(find("GET", "/api/inline-auth")!.requiredRoles[0], "public");
// Path arrays register each path.
assert.ok(find("GET", "/api/alpha") && find("GET", "/api/beta"));
// A guard registered later does not retroactively apply (ordered provenance).
assert.equal(find("GET", "/api/me")!.guards.every(g => g.source === "route"), true);
// False method flags are excluded.
assert.ok(find("GET", "/api/weird/weird"));
assert.equal(find("POST", "/api/weird/weird"), undefined, "false method flag excluded");
// Summary is derived from the rows.
assert.equal(inv.summary.total, inv.routes.length);
assert.equal(inv.summary.unknown, inv.routes.filter(r => r.access === "unknown").length);

// Mount prefixes are segment-based, parameters are wildcards.
assert.equal(mountCovers("/api/admin", "/api/admin/x"), true);
assert.equal(mountCovers("/api/adm", "/api/admin/x"), false);
assert.equal(mountCovers("/api/:org", "/api/admin/x"), true);

// Unrecorded mounts (registered before instrumentation) are unknown, not public.
const preRouter = express.Router();
const proto = Object.getPrototypeOf(Object.getPrototypeOf(preRouter)) as { use: (...a: unknown[]) => unknown };
const patchedUse = proto.use;
const app2 = express();
const sub = express.Router();
sub.get("/orphan", explicitPublic, noop);
const layersBefore = (app2 as unknown as { router: { stack: unknown[] } }).router.stack.length;
app2.use("/api/orphan", sub);
const stack2 = (app2 as unknown as { router: { stack: Array<Record<symbol, unknown>> } }).router.stack;
for (const l of stack2.slice(layersBefore)) delete l[Symbol.for("liberty.express.mountPaths")];
const inv2 = extractRouteInventory(app2);
const orphan = inv2.routes.find(r => r.path.endsWith("/orphan"))!;
assert.equal(orphan.access, "unknown", "unresolved mount never reported public even with an explicit public tag");
assert.ok(orphan.unresolved, "unresolved reason is carried");
assert.ok(inv2.summary.unresolvedMounts >= 1);
assert.equal(proto.use, patchedUse);

// Empty extraction on a registered app is unavailable, never a successful census.
const empty = extractRouteInventory(express());
assert.equal(empty.status, "unavailable");
assert.equal(empty.routes.length, 0);

// Source contracts: the route answers 503 on unavailable and the client surfaces errors.
const route_src = fs.readFileSync("server/routes/permissions-audit.ts", "utf8");
assert.ok(!/_router/.test(route_src), "legacy _router read removed");
assert.match(route_src, /status\(503\)/);
const client = fs.readFileSync("client/src/pages/dashboard/Permissions.tsx", "utf8");
assert.match(client, /isError/, "client renders query errors");
assert.ok(client.indexOf('user?.role !== "admin"') < client.indexOf("useQuery<"), "role denial precedes the reader");
const guardSrc = fs.readFileSync("server/replit_integrations/auth/replitAuth.ts", "utf8");
assert.match(guardSrc, /tagRoles<RequestHandler>\([\s\S]*?\}, roles\);/, "requireRole keeps its _requiredRoles tag");
const indexSrc = fs.readFileSync("server/index.ts", "utf8");
assert.ok(indexSrc.indexOf("instrumentExpressRouting();") < indexSrc.indexOf("const app = express();"));

console.log("stage3-c5 route inventory: all assertions passed");
