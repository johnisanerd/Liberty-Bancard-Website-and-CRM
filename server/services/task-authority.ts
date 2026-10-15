/**
 * Structural guard for Task 1721. Worker/service task creation must traverse
 * storage.createAuthorityTask so retries receive durable command and event
 * semantics. Kept callable from focused CI without coupling application boot
 * to filesystem layout.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function filesBelow(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

export function assertNoRawAutomaticTaskCreates(root = join(process.cwd(), "server")): void {
  const manualTaskRoute = join(root, "routes", "tickets-tasks.ts");
  const ignoredImplementations = new Set([
    join(root, "storage", "tasks.ts"),
    join(root, "services", "task-authority.ts"),
  ]);
  const violations = filesBelow(root).filter((file) => {
    if (ignoredImplementations.has(file) || file === manualTaskRoute) return false;
    return /\bstorage\.createTask\s*\(/.test(readFileSync(file, "utf8"));
  });
  // Interactive creation now uses the actor/version-bound human command.
  // No raw create is allowed in this route; do not reintroduce the retired
  // manual exception just to satisfy a structural test.
  const manualSource = readFileSync(manualTaskRoute, "utf8");
  const manualCreates = (manualSource.match(/\bstorage\.createTask\s*\(/g) ?? []).length;
  const manualHandler = manualSource.match(/app\.post\("\/api\/tasks"[\s\S]*?\n  \}\);/m)?.[0] ?? "";
  if (manualCreates !== 0 || !/\bcreateHumanTask\s*\(/.test(manualHandler) ||
      !/\btaskCreateCommand\.parse\s*\(/.test(manualHandler) ||
      !/\bbindWorkActor\s*\(/.test(manualHandler)) {
    violations.push(`${manualTaskRoute} (manual POST allowlist mismatch)`);
  }
  if (violations.length) {
    throw new Error(`Raw automatic storage.createTask calls are prohibited: ${violations.join(", ")}`);
  }
}