/**
 * Registration-bound Express 5 route inventory.
 *
 * Express 5 (router 2.x) keeps no mount path on `use()` layers and no
 * `app._router`. Walking the stack alone therefore loses every mount prefix.
 * This module records the explicit mount path of each `use()` registration on
 * the layer itself (via a symbol), then walks `app.router.stack` in
 * registration order carrying inherited, ordered guard provenance.
 *
 * Inventory only: it describes registered enforcement, it never grants or
 * loosens permission. Anything it cannot prove is reported as "unknown",
 * never as "public".
 */
import express from "express";
import type { Express } from "express";

export const MOUNT_PATHS = Symbol.for("liberty.express.mountPaths");
const PATCHED = Symbol.for("liberty.express.useInstrumented");

type GuardTag = readonly string[] | undefined;

interface Layer {
  route?: RouteLike;
  name?: string;
  handle?: ((...a: unknown[]) => unknown) & { stack?: Layer[]; _requiredRoles?: GuardTag; set?: unknown; router?: { stack?: Layer[] } };
  [MOUNT_PATHS]?: Array<string | RegExp | symbol>;
}
interface RouteLike {
  path?: string | RegExp | Array<string | RegExp>;
  methods?: Record<string, unknown>;
  stack?: Layer[];
}

export type RouteAccess = "public" | "authenticated" | "role" | "unknown";

export interface GuardProvenance {
  /** Where the guard was registered: a mount prefix or the route itself. */
  source: "mount" | "route";
  mountPath: string;
  roles: string[];
}

export interface InventoryRoute {
  method: string;
  path: string;
  access: RouteAccess;
  /** Effective roles (intersection of every role guard); empty unless access === "role". */
  roles: string[];
  guards: GuardProvenance[];
  /** Present when path or guard metadata could not be fully resolved. */
  unresolved?: string;
  /** Compatibility field: roles, or ["any-authenticated"|"public"|"unknown"]. */
  requiredRoles: string[];
}

export interface RouteInventory {
  status: "ok" | "unavailable";
  reason?: string;
  routes: InventoryRoute[];
  summary: { total: number; public: number; authenticated: number; role: number; unknown: number; unresolvedMounts: number };
  unsupported: string[];
}

const UNKNOWN_MOUNT = Symbol("unknown-mount");

type UseFn = (this: unknown, ...args: unknown[]) => unknown;

/**
 * Idempotently patches router.use so each registration records its mount path.
 * Must run before the registrations that should be resolvable; earlier layers
 * are reported as unresolved mounts rather than guessed.
 */
export function instrumentExpressRouting(): void {
  // router 2.x: each router function's prototype is a per-instance object whose prototype is the shared one.
  const proto = Object.getPrototypeOf(Object.getPrototypeOf(express.Router())) as { use: UseFn; [PATCHED]?: boolean };
  if (proto[PATCHED]) return;
  const original = proto.use;
  proto.use = function patchedUse(this: { stack: Layer[] }, ...args: unknown[]) {
    const before = this.stack.length;
    const result = original.apply(this, args);
    let offset = 0;
    let mount: Array<string | RegExp> = ["/"];
    const first = args[0];
    if (typeof first !== "function" && !(Array.isArray(first) && first.length && first.every(f => typeof f === "function"))) {
      offset = 1;
      mount = Array.isArray(first) ? (first as Array<string | RegExp>) : [first as string | RegExp];
    }
    const fnCount = args.slice(offset).flat(Infinity).length;
    // original.use pushes one layer per handler in registration order.
    for (let i = before; i < before + fnCount && i < this.stack.length; i++) this.stack[i][MOUNT_PATHS] = mount;
    return result;
  } as UseFn;
  proto[PATCHED] = true;
}

function joinPath(base: string, part: string): string {
  const joined = `${base}/${part}`.replace(/\/{2,}/g, "/");
  return joined.length > 1 ? joined.replace(/\/$/, "") : joined;
}

function pathSegments(p: string): string[] {
  return p.split("/").filter(Boolean);
}

/** A mount prefix matches when every prefix segment equals or is a parameter/wildcard. */
export function mountCovers(mount: string, full: string): boolean {
  const m = pathSegments(mount);
  const f = pathSegments(full);
  if (m.length > f.length) return false;
  return m.every((seg, i) => seg.startsWith(":") || seg === "*" || seg.startsWith("*") || f[i].startsWith(":") || seg === f[i]);
}

function roleTag(handle: Layer["handle"]): string[] | undefined {
  const tag = handle?._requiredRoles;
  return Array.isArray(tag) && tag.length > 0 ? [...tag] : undefined;
}

function expandPaths(p: unknown, unsupported: string[]): string[] | null {
  const values = Array.isArray(p) ? p : [p];
  const out: string[] = [];
  for (const v of values) {
    if (typeof v === "string") out.push(v);
    else {
      unsupported.push(`Non-string path ${String(v)} is not representable`);
      return null;
    }
  }
  return out;
}

interface ActiveGuard { mountPath: string; roles: string[] }

function classify(guards: GuardProvenance[], unresolved: string | undefined): Pick<InventoryRoute, "access" | "roles" | "requiredRoles"> {
  const roleGuards = guards.filter(g => g.roles.some(r => r !== "any-authenticated" && r !== "public"));
  const hasAuthenticated = guards.some(g => g.roles.includes("any-authenticated"));
  const hasPublic = guards.some(g => g.roles.includes("public"));
  if (roleGuards.length) {
    // Conjunction of every guard: only roles permitted by all of them remain.
    let effective = roleGuards[0].roles.filter(r => r !== "any-authenticated" && r !== "public");
    for (const g of roleGuards.slice(1)) effective = effective.filter(r => g.roles.includes(r));
    return { access: "role", roles: effective, requiredRoles: effective.length ? effective : ["no-role-satisfies-all-guards"] };
  }
  if (hasAuthenticated) return { access: "authenticated", roles: [], requiredRoles: ["any-authenticated"] };
  if (hasPublic && !unresolved) return { access: "public", roles: [], requiredRoles: ["public"] };
  return { access: "unknown", roles: [], requiredRoles: ["unknown"] };
}

export function extractRouteInventory(app: Express): RouteInventory {
  const unsupported: string[] = [];
  const routes: InventoryRoute[] = [];
  let unresolvedMounts = 0;
  const root = (app as unknown as { router?: { stack?: Layer[] } }).router?.stack;
  if (!Array.isArray(root)) {
    return emptyInventory("unavailable", "Express router stack is not readable on this Express version", unsupported);
  }

  const walk = (layers: Layer[], prefix: string, inherited: ActiveGuard[], prefixUnresolved: string | undefined): void => {
    // Guards registered at this level apply only to later registrations (ordered).
    let active = [...inherited];
    for (const layer of layers) {
      if (layer.route) {
        const paths = expandPaths(layer.route.path, unsupported);
        if (!paths) continue;
        const methodMap = layer.route.methods ?? {};
        const methods = Object.keys(methodMap).filter(m => methodMap[m] === true);
        const routeGuards: GuardProvenance[] = [];
        for (const sub of layer.route.stack ?? []) {
          const roles = roleTag(sub.handle);
          if (roles) routeGuards.push({ source: "route", mountPath: "(route)", roles });
        }
        for (const sub of paths) {
          const full = joinPath(prefix, sub);
          const inheritedFor: GuardProvenance[] = active
            .filter(g => mountCovers(g.mountPath, full))
            .map(g => ({ source: "mount" as const, mountPath: g.mountPath, roles: g.roles }));
          const guards = [...inheritedFor, ...routeGuards];
          const unresolved = prefixUnresolved;
          const cls = classify(guards, unresolved);
          for (const m of methods) {
            routes.push({
              method: m === "_all" ? "ALL" : m.toUpperCase(),
              path: full,
              guards,
              ...(unresolved ? { unresolved } : {}),
              ...cls,
              // Unresolved ancestry can never be asserted public.
              ...(unresolved && cls.access === "public" ? { access: "unknown" as const, requiredRoles: ["unknown"] } : {}),
            });
          }
        }
        continue;
      }
      const nested = layer.handle?.stack ?? layer.handle?.router?.stack;
      const mounts = layer[MOUNT_PATHS];
      const resolvedMounts: Array<string | typeof UNKNOWN_MOUNT> = mounts
        ? mounts.map(m => (typeof m === "string" ? m : (unsupported.push(`Regex mount ${String(m)} is not representable`), UNKNOWN_MOUNT)))
        : [UNKNOWN_MOUNT];
      if (!mounts) unresolvedMounts++;
      if (Array.isArray(nested)) {
        for (const m of resolvedMounts) {
          const known = m !== UNKNOWN_MOUNT;
          walk(
            nested,
            known ? joinPath(prefix, m as string) : prefix,
            active,
            prefixUnresolved ?? (known ? undefined : "mount path of an enclosing router was not recorded"),
          );
        }
        continue;
      }
      const roles = roleTag(layer.handle);
      if (roles) {
        for (const m of resolvedMounts) {
          if (m === UNKNOWN_MOUNT) continue; // cannot apply an unmounted guard to a path; its routes stay unknown
          active = [...active, { mountPath: joinPath(prefix, m as string), roles }];
        }
      }
    }
  };
  walk(root, "", [], undefined);

  routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  if (routes.length === 0) {
    return emptyInventory("unavailable", "No routes were extracted from a registered application", unsupported);
  }
  return {
    status: "ok",
    routes,
    summary: {
      total: routes.length,
      public: routes.filter(r => r.access === "public").length,
      authenticated: routes.filter(r => r.access === "authenticated").length,
      role: routes.filter(r => r.access === "role").length,
      unknown: routes.filter(r => r.access === "unknown").length,
      unresolvedMounts,
    },
    unsupported: [...new Set(unsupported)],
  };
}

function emptyInventory(status: "unavailable", reason: string, unsupported: string[]): RouteInventory {
  return { status, reason, routes: [], summary: { total: 0, public: 0, authenticated: 0, role: 0, unknown: 0, unresolvedMounts: 0 }, unsupported };
}
